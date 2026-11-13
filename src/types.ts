import type { LimitUsage, LLMCall, UsageSummary } from './providers/types';

export const MAX_AGENT_RETRIES = 1;

export type FindingSeverity = 'blocker' | 'warning' | 'note' | 'ignore';

/** Severities from most to least severe. */
export const SEVERITY_ORDER: readonly FindingSeverity[] = ['blocker', 'warning', 'note', 'ignore'];

/** The grades of an earlier finding or thread: its own severity, and those the round records gave it. */
export interface ThreadGrade {
  severity: FindingSeverity | 'unknown';
  /** The grade the round records last gave it. */
  recordedGrade?: FindingSeverity;
  /** The highest grade the round records ever gave it. */
  peakGrade?: FindingSeverity;
  /** Set when a round record that may have raised it could not be read, so it may be graded anything. */
  gradeUnknown?: boolean;
}

/**
 * Whether a finding of `severity` is graded above an earlier finding or thread: above its own severity and above the
 * highest grade the round records gave it, which a later round gives back when it names the problem again. One of
 * `unknown` grade predates the markers and counts as a blocker, and so does one whose records could not all be read.
 * An earlier finding graded below never carries, waives or hides a new one.
 */
export function gradedAbove(severity: FindingSeverity, earlier: ThreadGrade): boolean {
  if (earlier.gradeUnknown) return false;
  const own = earlier.severity === 'unknown' ? 'blocker' : earlier.severity;
  const rank = SEVERITY_ORDER.indexOf(severity);
  return [own, earlier.peakGrade ?? earlier.recordedGrade].every(grade => !grade || rank < SEVERITY_ORDER.indexOf(grade));
}

/** What a review calls each severity. A note is posted as a suggestion. */
export const SEVERITY_NAME: Record<FindingSeverity, string> = {
  blocker: 'blocker',
  warning: 'warning',
  note: 'suggestion',
  ignore: 'ignore',
};

export type CellRow = 'severe' | 'wrong' | 'degraded' | 'improvement' | 'style';
export type CellColumn = 'normal' | 'rare';

/** A cell of the judge's severity table: what goes wrong, and whether normal use or outside input reaches it. */
export interface GradeCell {
  row: CellRow;
  column: CellColumn;
  /** The column the judge stated, when Manki grades in another one: it is a security finding, or the cell is what remains of a partly fixed thread. An earlier record can hold it for a finding a tool check moved. */
  judgeColumn?: CellColumn;
}

/** The grade of each severity table cell, by row. */
export const CELL_GRADES: Readonly<Record<CellRow, Readonly<Record<CellColumn, FindingSeverity>>>> = {
  severe: { normal: 'blocker', rare: 'blocker' },
  wrong: { normal: 'blocker', rare: 'warning' },
  degraded: { normal: 'warning', rare: 'note' },
  improvement: { normal: 'note', rare: 'note' },
  style: { normal: 'note', rare: 'note' },
};

export function cellGrade(row: CellRow, column: CellColumn): FindingSeverity {
  return CELL_GRADES[row][column];
}

/** Whether `cell` names a row and a column of the table. A stored record can hold a cell another Manki version wrote. */
export function isGradeCell(cell: GradeCell | undefined): cell is GradeCell {
  return !!cell && Object.hasOwn(CELL_GRADES, cell.row) && (cell.column === 'normal' || cell.column === 'rare');
}

/** Whether the column decides if a finding on `row` blocks. */
export function columnDecidesBlock(row: CellRow): boolean {
  return cellGrade(row, 'normal') === 'blocker' && cellGrade(row, 'rare') !== 'blocker';
}

/** Whether `cell` is in the `rare` column of a row where `columnDecidesBlock`, so the column is a claim the refuter checks. */
export function isRareClaim(cell: GradeCell | undefined): boolean {
  return isGradeCell(cell) && columnDecidesBlock(cell.row) && cell.column === 'rare';
}

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
 * Maps a severity an older version of Manki wrote to the current `FindingSeverity` set. `required` is `blocker`, and
 * `suggestion`, `nitpick` and `nit` are `note`. Any other value is returned as it is.
 */
export function migrateLegacySeverity(severity: string): FindingSeverity | string {
  if (severity === 'required') return 'blocker';
  if (severity === 'suggestion' || severity === 'nitpick' || severity === 'nit') return 'note';
  return severity;
}

/** The fields that hold a severity wherever they sit in a stored record. */
const SEVERITY_FIELDS: ReadonlySet<string> = new Set(['severity', 'originalSeverity', 'reviewerSeverity', 'gradeIfConfirmed', 'recordedGrade', 'peakGrade']);

/** The severity fields of the entries of a list. `from`, `to` and `grade` are common names, so they count only in the list named here. */
const SEVERITY_FIELDS_OF = new Map<string, ReadonlySet<string>>([
  ['gradePath', new Set([...SEVERITY_FIELDS, 'from', 'to'])],
  ['threadEvaluations', new Set([...SEVERITY_FIELDS, 'grade'])],
]);

/** The fields that hold a stored config, whose values are a user's own and never a stored severity. */
const CONFIG_FIELDS: ReadonlySet<string> = new Set(['config', 'overrides']);

/**
 * Rewrites, in place, every severity in a parsed record that an older version of Manki wrote, at any depth, and
 * returns the record. A count keyed by severity is added to the count of the severity it migrates to. A `gradePath`
 * step between two levels that are now one is dropped. A stored config is left as it is.
 */
export function migrateStoredSeverities<T>(record: T): T {
  migrateFields(record, SEVERITY_FIELDS);
  return record;
}

function migrateFields(record: unknown, severityFields: ReadonlySet<string>): void {
  if (Array.isArray(record)) {
    for (const entry of record) migrateFields(entry, severityFields);
  } else if (record && typeof record === 'object') {
    const fields = record as Record<string, unknown>;
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'string' && severityFields.has(key)) fields[key] = migrateLegacySeverity(value);
      else if (key === 'severityCounts' && value && typeof value === 'object') fields[key] = migrateSeverityCounts(value as Record<string, unknown>);
      else if (!CONFIG_FIELDS.has(key)) migrateFields(value, SEVERITY_FIELDS_OF.get(key) ?? SEVERITY_FIELDS);
    }
    // `gradeStep` writes no step between equal grades, so a step whose grades the migration made equal is dropped.
    if (Array.isArray(fields.gradePath)) {
      const steps = fields.gradePath.filter((step: Partial<GradeStep> | null) => !step || step.from !== step.to);
      if (steps.length > 0) fields.gradePath = steps;
      else delete fields.gradePath;
    }
  }
}

function migrateSeverityCounts(counts: Record<string, unknown>): Record<string, unknown> {
  const migrated: Record<string, unknown> = {};
  for (const [severity, count] of Object.entries(counts)) {
    const key = migrateLegacySeverity(severity);
    migrated[key] = typeof count === 'number' && typeof migrated[key] === 'number' ? count + (migrated[key] as number) : count;
  }
  return migrated;
}

/** Whether a finding of this severity is posted as a review thread, unless it is a follow-up. */
export function isBlockingSeverity(severity: FindingSeverity): boolean {
  return severity === 'blocker' || severity === 'warning';
}

export function findingKey(f: Pick<Finding, 'file' | 'line' | 'title'>): string {
  return `${f.file}:${f.line}:${f.title}`;
}

/** Whether a finding of this severity is a note: the review lists it, and it never blocks. */
export function isNote(severity: FindingSeverity): boolean {
  return severity === 'note';
}


/** Regex source matching all current and legacy severity tokens. */
export const SEVERITY_TOKEN_PATTERN = 'blocker|warning|note|ignore|suggestion|nitpick|required|nit';

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

// Priors saved before the generalist finders carry this reviewer instead of the judge's `security` tag.
const LEGACY_SECURITY_AGENT_NAME = 'Security & Safety';

/**
 * Whether a finding or prior is a security defect, which the judge tags `SECURITY_TAG`.
 * A prior also counts when the retired Security & Safety reviewer raised it.
 */
export function isSecurityFinding(tags: string[] | undefined, priorReviewers: ReadonlyArray<string | undefined> = []): boolean {
  return Boolean(tags?.includes(SECURITY_TAG)) || priorReviewers.includes(LEGACY_SECURITY_AGENT_NAME);
}

/** Whether a step that leaves out notes may leave the finding out of the review: only a note, and never a security finding or a tool alert. */
export function canLeaveOut(f: Finding): boolean {
  return isNote(f.severity) && !f.toolSource && !isSecurityFinding(f.tags, f.reviewers);
}

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
  tags?: string[];
  originalSeverity?: FindingSeverity;
  /**
   * The highest severity a reviewer gave the finding or a duplicate merged into it. Set when the judge graded the
   * finding differently, or when a merged duplicate was filed higher. The judge never sees it.
   */
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
  /** Whether the round lists an earlier blocker again that no thread carries, so it gets a thread. No model raised it this round. */
  relisted?: boolean;
  /**
   * Whether the finding is posted on its own even beside an open thread with its title: a security finding next to a
   * thread without a security guard, or one whose reply in its thread failed.
   */
  ownThread?: boolean;
  /** Tool that reported the finding, when it comes from a CI or code-scanning result instead of a reviewer. */
  toolSource?: string;
  /** What the deterministic claim checks and CI results say about the finding. */
  toolEvidence?: ToolEvidence;
  /** Whether the judge or the verdict reader says the finding claims the code fails to compile, type-check or pass its tests. */
  buildClaim?: boolean;
  /** Earlier finding this one resembles, whose fix the judge of an earlier round confirmed. */
  resemblesFixed?: { title: string; file: string; line: number };
  /**
   * The Manki thread that already answered the developer about this problem, that answer and the thread's grades. The
   * judge keeps the finding only when the code there got worse.
   */
  answeredIn?: { threadId: string; answer: string; grade: ThreadGrade };
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
  /** The severity table cell the grade is worked out from. The judge states it, and no tool check moves its column. */
  cell?: GradeCell;
  /** The cell the judge stated, on a blocker `applyRefutation` put back at its finders' grade. Only for the record: no prompt shows it. */
  judgeCell?: GradeCell;
  /**
   * The grade the finding gets once every premise in `doubts` holds. Set when the finding has a doubt. Manki works it
   * out from the `cell`, except that it is `warning` in a cell that gives a blocker when the judge stated `warning`.
   * The refuter checks the finding, and a confirmation of every doubt gives it this grade. A blocker cell that no
   * finder filed as a blocker, that is no security finding and that restates no earlier blocker needs more: every
   * check confirms the defect and a `consequence` premise. Before its checks, `refuteBlockers` sets `warning` here on
   * such a finding without a `consequence` premise. On a finding that `isRareClaim` it is the grade of
   * the `normal` column, which no confirmation gives.
   */
  gradeIfConfirmed?: FindingSeverity;
  /** The judge's own answer for `gradeIfConfirmed`, on a finding with a doubt. Unset when it stated none. Only for the record. */
  judgeIfConfirmed?: 'blocker' | 'warning';
  /** The premises the judge doubts, which the refuter checks one by one. */
  doubts?: Doubt[];
  /** How the judge's attempt to refute the finding with tools came out. Set on blockers, open leads, findings lowered for want of proof and findings checked for a doubt the judge named. */
  refutation?: Refutation;
  /** How the second refuter, on `models.refuter_pair`, came out. Set beside `refutation` when that model checked the finding. */
  pairRefutation?: Refutation;
  /** The id of the memory suppression that hid the finding. */
  suppressedBy?: string;
  /** Why the review leaves the finding out. Only the round record keeps such a finding. */
  unpostedReason?: UnpostedReason;
  /** Set on a warning the refuter could have checked, had `MAX_DOUBT_CHECKS` other warnings not taken the round's checks. */
  overCheckLimit?: true;
  /** How the finding was checked. Set on each blocker and warning a round posts, except a tool alert. */
  checkStatus?: CheckStatus;
  /** The finding's place in the judge's order of the notes, 0 for the one the author gains most from. Unset when the judge did not rank it. */
  noteRank?: number;
  /** Why the defect exists without this PR's change, when the reviewer says so. The judge must keep it, or it is cleared. */
  preExisting?: string;
  /** How a claim in `preExisting` was checked against the diff: held, or the condition that failed. */
  preExistingCheck?: PreExistingCheck;
  /** The rule of an instruction file the reviewer says the change breaks. Only a `confirmed` one counts in the grade. */
  rule?: RuleMark;
}

/**
 * What the judge said about a quoted rule: `confirmed` when the quote states a requirement, this PR breaks it and a
 * proving line is cited. It is `unproven` when code the judge could not see decides it, or when the judge says the
 * rule is broken without a proving line. A refuter that confirms the unseen fact of an `unproven` rule makes it
 * `confirmed`. Any other answer names the first check that failed.
 */
export type RuleVerdict = 'confirmed' | 'no_requirement' | 'not_broken' | 'unproven';

/** A rule quoted from an instruction file of the base branch, with the judge's answer once the judge saw the finding. */
export interface RuleMark {
  file: string;
  quote: string;
  verdict?: RuleVerdict;
  /** The fact the judge could not see that would make the rule broken. The rule is `confirmed` only once a refuter confirmed it. */
  unseen?: string;
}

/** Whether the judge confirmed that `finding` breaks a required rule of the instruction files. */
export function breaksRule(finding: Pick<Finding, 'rule'>): boolean {
  return finding.rule?.verdict === 'confirmed';
}

/** How a broken required rule is graded, the `review.rules` setting: `warn` posts a warning, `block` a blocker. */
export type RulesMode = 'warn' | 'block';

/** The `review.sweep` setting. Each value past `off` names the lowest grade of a kept finding that starts a sweep. */
export const SWEEP_MODES = ['off', 'blockers', 'warnings', 'notes'] as const;
export type SweepMode = typeof SWEEP_MODES[number];

/**
 * How a pre-existing claim the reviewer made and the judge kept was checked: `pre_existing` when it held, or the
 * condition that failed: no location, a file `exclude_paths` left out, a file the PR deletes, or a line or proof
 * inside the diff.
 */
export type PreExistingCheck = 'pre_existing' | 'no_location' | 'excluded_file' | 'deleted_file' | 'touches_diff';

/** How a round split a diff too large to read at once. */
/** What a model guessed each related repo calls the names of the diff, for the search of that repo. */
export interface NameTranslation {
  /** Per repo as `owner/name`, then per name of the diff, the names to search that repo for as well. */
  names: Map<string, Map<string, string[]>>;
  /** Why nothing was translated, when the call failed or its reply could not be used. */
  skipped?: string;
}

/** What a model guessed each related repo calls the code that decides a claim of the PR text, for the search of that repo. */
export interface ClaimTerms {
  /** Per repo as `owner/name`, then per position of the claim in the round's list, the identifiers to search that repo for. */
  terms: Map<string, Map<number, string[]>>;
  /** Usable terms the reply gave past the cap for one claim and repo. */
  cut?: number;
  /** Why no term was guessed, when the call failed or its reply could not be used. */
  skipped?: string;
}

/** A fetched related repo: its `owner/name`, its kind and the directory holding its checkout. */
export interface RelatedCheckout {
  repo: string;
  kind: RelatedRepoKind;
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

export interface RoundInstructions {
  files: string[];
  /** The file cut at the size limit. Files after it were left out, so the round saw no rule of theirs. */
  cut?: string;
}

/** How one configured related repo fared in a round, and how often the round's finders read it. */
export interface RoundRelatedRepo {
  repo: string;
  ref?: string;
  /**
   * `fetched`, `failed` with the `reason`, `unused` when nothing asked for it, or `skipped` with the `reason` when the
   * round gave no model the repo.
   */
  status: 'fetched' | 'failed' | 'unused' | 'skipped';
  reason?: string;
  /** How long the fetch took, when it ended. */
  durationMs?: number;
  /** Tool calls that read the repo, over every call of the round. */
  reads?: number;
  /** Those tool calls by the stage that made them, with the refuters as `refute` and `refute_pair`. */
  readsByStage?: Record<string, number>;
  /** The guide file at the repo's root that the round's models were pointed to as a map of the repo. */
  guide?: string;
  /** The commit the round checked out, when it fetched the repo. */
  commit?: string;
  /** The time the round read the repo as of, when it did not read the newest commit. */
  asOf?: string;
}

/** What the "Uses Outside the Diff" section showed the finders, as locations without the quoted code. */
export interface RoundUses {
  /** Why the search of the PR's head commit failed, which leaves the lists of that search unset and the finders without the section. */
  failed?: string;
  /** Each symbol listed with its uses. */
  symbols?: RoundUsesSymbol[];
  /** Each type listed with all its fields, as `file:line: struct Name { fields }`. */
  types?: string[];
  /** Symbols named but not listed, since they have too many uses. */
  common?: string[];
  /** Symbols the cap on listed lines left out. */
  capped?: string[];
  /** Names that were not searched for, since the search pattern was full. */
  unsearched?: string[];
  /** Each name found in the reference repos, with the lines shown. */
  reference?: RoundReferenceUse[];
  /** Names searched for that no reference line holds. */
  referenceMissing?: string[];
  /** Names found in the reference repos that the cap on reference lines left out. */
  referenceCapped?: string[];
  /** Names found in no reference line that were not searched for everywhere: the search pattern was full, or the search of a repo failed. */
  referenceUnsearched?: string[];
  /** Each name found in the consumer repos, with the lines shown. */
  consumer?: RoundReferenceUse[];
  /** Names searched for that no consumer line holds. */
  consumerMissing?: string[];
  /** Names found in the consumer repos that the cap on consumer lines left out. */
  consumerCapped?: string[];
  /** Names found in no consumer line that were not searched for everywhere: the search pattern was full, or the search of a repo failed. */
  consumerUnsearched?: string[];
  /** Each name found in the dependency repos, with the lines shown. */
  dependency?: RoundReferenceUse[];
  /** Names searched for that no dependency line holds. */
  dependencyMissing?: string[];
  /** Names found in the dependency repos that the cap on dependency lines left out. */
  dependencyCapped?: string[];
  /** Names found in no dependency line that were not searched for everywhere: the search pattern was full, or the search of a repo failed. */
  dependencyUnsearched?: string[];
  /** The names a model translated for the search of the related repos. Unset when that search did not run. */
  translation?: RoundNameTranslation;
  /** The terms searched in the related repos for the claims of the PR text. Unset when the round had no claim or fetched no related repo for one. */
  claimTerms?: RoundClaimTerms;
}

export interface RoundReferenceUse {
  name: string;
  /** Each line shown, as `owner/name:path:line`. */
  lines: string[];
  /** Lines found but not shown. */
  notShown?: number;
  /** The translated names that found some of the lines shown. */
  as?: string[];
}

/** What the name translation before the related repo search gave. */
export interface RoundNameTranslation {
  /** Why no name was translated, so the search ran with the original names only. */
  skipped?: string;
  /**
   * Each translated name searched for: the repo, the diff's name, the name searched as, and the lines of the repo that
   * hold it. `failed` is set when the search for it, or for the diff's names in that repo, failed, so `lines` says nothing.
   */
  names?: Array<{ repo: string; name: string; as: string; lines: number; failed?: true }>;
}

/** What the search of the related repos for the claims of the PR text gave, which only the claims' own checks are shown. */
export interface RoundClaimTerms {
  /** Why no term was guessed or the search did not finish, so every claim check started without lines of the related repos. */
  skipped?: string;
  /**
   * Each term a model guessed: the position of its claim in `prClaims.claims`, the repo, the term, the lines of the repo
   * that hold it and how many of them the claim's check was shown. `notShown` says why a term showed none: it is too
   * short or too generic to search for (`unsearchable`), too many lines hold it (`common`), or its search failed or left
   * it out (`failed`, where `lines` says nothing). A term with fewer `shown` than `lines` and no `notShown` was cut by a cap.
   */
  terms?: Array<{ claim: number; repo: string; term: string; lines: number; shown: number; notShown?: 'unsearchable' | 'common' | 'failed' }>;
  /** Terms the model gave past the cap for one claim and repo, which were not searched. */
  cut?: number;
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

/** A search of the diff for other instances of one finding's defect class. */
export interface RoundSweep {
  /** The reviewer name its findings carry. */
  reviewer: string;
  /** The finding it started from, as `file:line`. */
  source: string;
  /** The grade of that finding when the sweep started. */
  severity: FindingSeverity;
  /**
   * `too_specific` when the call judged the class too narrow to recur, `failed` when the call failed or its reply did not
   * parse twice, and `cut` when the round's cap left it out.
   */
  status: 'answered' | 'too_specific' | 'failed' | 'cut';
  /** The defect class in general terms, as the call stated it. */
  class?: string;
  /** The other places it reported, before dedup and the judge. */
  findings?: number;
}

/** A statement of the PR author that the change relies on, quoted word for word from the PR text. */
export interface PrClaim {
  quote: string;
  /** `description` for the PR title or description, or the `file:line` of the comment the change adds. */
  source: string;
}

/** A claim of the round and how its check ended. */
export interface RoundPrClaim extends PrClaim {
  /** The reviewer name its findings carry. */
  reviewer: string;
  /**
   * `proven` or `disproven` only when the check cited a line that exists in the head commit or in a related repo the
   * round fetched. Every other end is `unchecked`. It is a record only: no stage is shown it and no grade depends on it.
   */
  status: 'proven' | 'disproven' | 'unchecked';
  /**
   * Why the check gave no answer: `failed` when the call failed or its reply did not parse twice, `timed_out` when it
   * was still unanswered once the grace after the finders ran out, and `skipped` when no check ran: the quick check
   * alone read the change, or no repository tools were there.
   */
  call?: 'failed' | 'timed_out' | 'skipped';
  /** What decided it, or what is left to check, as the check stated it. */
  reason?: string;
  /** The existing `file:line` locations the check cited for `proven` or `disproven`. */
  proof?: string[];
  /** The lines of related repos it cited for that, as `owner/name:path:line`, each in a checkout the round fetched. */
  relatedProof?: string[];
  /** The defects it reported for a `disproven` claim, before dedup and the judge. */
  findings?: number;
}

/** The claims a round took from the PR text, each with its check. */
export interface RoundPrClaims {
  /** Why no claim was taken from the PR text: the call failed, its reply could not be used or no model is set up for it. */
  skipped?: string;
  /** Statements the PR text holds that the cap on claims left out. */
  cut?: number;
  claims?: RoundPrClaim[];
}

export interface RoundSlicing {
  /** The changed files in each slice. A file split across slices counts in each. */
  files: number[];
  /** The verdict reader's answer on each slice, when it ran. */
  reader?: Array<{ verdict: VerdictReport['verdict']; blockers: number }>;
}

/** What changed a finding's severity. */
export type GradeChange =
  | 'judge' | 'rule' | 'unproven' | 'build_claim' | 'refutation' | 'in_pr_suppression' | 'own_proposal' | 'contradiction' | 'ratchet'
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

/** Returns the highest grade a finder gave `finding` or a duplicate merged into it. */
export function finderGrade(finding: Pick<Finding, 'reviewerSeverity' | 'gradePath' | 'severity'>): FindingSeverity {
  return finding.reviewerSeverity ?? finding.gradePath?.[0]?.from ?? finding.severity;
}

/**
 * Returns the grade a check gives `f` when it confirms every premise in its `doubts`. A finding that `isRareClaim` has
 * none: its `gradeIfConfirmed` is the grade of the `normal` column, and no answer moves it there.
 */
export function pendingGrade(f: Pick<Finding, 'gradeIfConfirmed' | 'cell'>): FindingSeverity | undefined {
  return isRareClaim(f.cell) ? undefined : f.gradeIfConfirmed;
}

/**
 * Whether the cell of `f` gives a blocker that no confirmation of its doubts gives. Either the judge stated `warning`
 * for that case, or `refuteBlockers` set it because no finder filed a blocker and the judge named no `consequence` premise.
 */
export function staysWarningIfConfirmed(f: Pick<Finding, 'gradeIfConfirmed' | 'cell'>): boolean {
  return f.gradeIfConfirmed === 'warning' && isGradeCell(f.cell) && cellGrade(f.cell.row, f.cell.column) === 'blocker';
}

/** Whether the judge or a finder graded `f` a blocker at any point, or its `pendingGrade` is one. */
export function wouldBlockIfTrue(f: Pick<Finding, 'gradeIfConfirmed' | 'cell' | 'reviewerSeverity' | 'gradePath'>): boolean {
  return pendingGrade(f) === 'blocker' || f.reviewerSeverity === 'blocker' || !!f.gradePath?.some(step => step.from === 'blocker' || step.to === 'blocker');
}

/** Whether `applyRefutation` put the blocker the judge alone made of `finding` back at its finders' grade. Nothing else lowers a blocker by a refutation. */
export function isDisprovedRaise(finding: Pick<Finding, 'gradePath'>): boolean {
  return !!finding.gradePath?.some(step => step.by === 'refutation' && step.from === 'blocker');
}

export type RefutationOutcome = 'disproved' | 'confirmed' | 'unsettled';

/**
 * A premise the judge doubts, stated as a fact the code can confirm or disprove. It `decides` either whether the defect
 * exists at all, so a disproof drops the finding, or only which cell the finding belongs in, such as whether normal
 * use or outside input produces the state a finding in the `rare` column needs.
 */
export interface Doubt {
  premise: string;
  decides: 'defect' | 'grade';
  /** Set on the `grade` premise about the damage that makes the cell's row a blocker, worded so the blocker needs it true. */
  consequence?: true;
}

/**
 * The claim the `rare` column makes on a row where `columnDecidesBlock`, as a premise for the refuter. Manki adds it to
 * every finding in such a cell. The refuter's answer is recorded and never moves the finding to the `normal` column.
 */
export const REACH_DOUBT: Doubt = { premise: 'Normal use or outside input can produce the state this failure needs', decides: 'grade' };

/** Returns `doubts` with `REACH_DOUBT` in place of any doubt that words the same premise. */
export function withReachDoubt(doubts: readonly Doubt[] = []): Doubt[] {
  return [...doubts.filter(d => d.premise !== REACH_DOUBT.premise), REACH_DOUBT];
}

/** How a refuter answered one premise the judge doubts. */
export interface PremiseCheck {
  premise: string;
  outcome: RefutationOutcome;
  reason: string;
  proof?: string[];
  /** The lines of related repos that decide it, as `owner/name:path:line`. They can confirm, and never count toward a disproof. */
  relatedProof?: string[];
}

/** The outcome of the judge's attempt to refute a finding with tools. */
export interface Refutation {
  /** What the check means for the finding's grade: the answer to the whole finding, or what its `premises` add up to. */
  outcome: RefutationOutcome;
  /** The refuter's own answer whether the defect exists, whatever it found about the premises. A record from before this was stored has none. */
  defect?: RefutationOutcome;
  /** What decided it, in one or two sentences. */
  reason: string;
  /** The general rule of the language, a library or a protocol that the finding relies on, as the refuter named it. */
  rule?: string;
  /** The `file:line` locations the judge cites: the failure for `confirmed`, the reason it cannot happen for `disproved`. */
  proof?: string[];
  /**
   * The lines of related repos the outcome cites, as `owner/name:path:line`, each in a checkout the round fetched. They
   * can confirm, and never count toward a disproof. A check that cites one is never reused in a later round.
   */
  relatedProof?: string[];
  /** The answer to each premise in the finding's `doubts`, in order. The `outcome` follows from them. */
  premises?: PremiseCheck[];
  /** The finding's own file and the files the outcome cites. */
  files: string[];
  /** SHA-256 over `files` at the commit checked. A later round reuses the outcome while it still matches. */
  codeDigest: string;
  /** The model that answered. A record from before models were stored has none. */
  model?: string;
  /**
   * Whether the call of a check that ended unsettled ended on its step budget: it was told to wrap up or took every
   * tool step. `yes` states that count alone, so it also holds for a call that was done anyway. It is `unknown` when the
   * client does not report the steps of a call. Unset on a check that settled, and on a record from before this was stored.
   */
  stepsUsedUp?: 'yes' | 'no' | 'unknown';
}

/**
 * Returns what `check` says about its finding. It is `disproved` when the refuter answered that the defect does not
 * exist, whatever its `premises` add up to. Otherwise it is the check's `outcome`.
 */
export function outcomeOf(check: Refutation): RefutationOutcome {
  return check.defect === 'disproved' ? 'disproved' : check.outcome;
}

/**
 * Returns the `outcome` that `checks` agree on, which decides whether a grade is restored and whether a blocker is
 * lowered. An unsettled check abstains, and a confirmation against a disproof settles nothing. So no check confirms
 * beside one that disproves, be it the finding, the defect or a premise that only decides the grade.
 */
export function agreedOutcome(checks: readonly Refutation[]): RefutationOutcome {
  const votes = new Set(checks.map(r => r.outcome).filter(o => o !== 'unsettled'));
  if (votes.size !== 1) return 'unsettled';
  const [outcome] = votes;
  return outcome === 'confirmed' && checks.some(r => outcomeOf(r) === 'disproved' || r.premises?.some(p => p.outcome === 'disproved')) ? 'unsettled' : outcome;
}

/** Whether every check in `checks` confirmed the defect and each premise, so none left one open or contradicted itself. */
export function confirmsAll(checks: readonly Refutation[]): boolean {
  return checks.length > 0 && checks.every(r => r.defect === 'confirmed' && r.outcome === 'confirmed');
}

/**
 * Returns the refutation that disproves `finding`, by `outcomeOf`: in a premise the defect rests on, or in its answer
 * whether the defect exists. Returns none when another check backs the finding, since a confirmation against a
 * disproof settles nothing. A check backs it when it does not disprove it and confirmed the defect or one of the premises.
 */
export function disproof(finding: Pick<Finding, 'refutation' | 'pairRefutation'>): Refutation | undefined {
  const checks = [finding.refutation, finding.pairRefutation].filter((r): r is Refutation => !!r);
  const backs = (check: Refutation): boolean => outcomeOf(check) !== 'disproved' && (check.defect === 'confirmed' || !!check.premises?.some(p => p.outcome === 'confirmed'));
  return checks.some(backs) ? undefined : checks.find(check => outcomeOf(check) === 'disproved');
}

/**
 * Returns the refutation that disproves a finding that `breaksRule` and is graded below blocker. Such a finding stays in
 * the review whatever the check disproved: the refuter checks whether a failure can happen, not whether a rule is
 * followed, and the same rule break with no damage to check is posted unchecked.
 */
export function overruledDisproof(finding: Pick<Finding, 'severity' | 'rule' | 'refutation' | 'pairRefutation'>): Refutation | undefined {
  return finding.severity === 'blocker' || finding.severity === 'ignore' || !breaksRule(finding) ? undefined : disproof(finding);
}

/** `earlier` restates a finding an earlier round listed in its review body, whatever code it sits on. */
export type FindingOrigin = 'new' | 'reviewed' | 'earlier';

/** Why a review leaves out a finding the judge kept, with the words that say it to a reader. The first three are set on a note, `listed_earlier` also on a finding that restates an earlier blocker the round lists again, and the last three on a warning nothing proves. */
export const UNPOSTED_REASONS = {
  reviewed_code: 'on code an earlier round reviewed',
  listed_earlier: 'listed by an earlier round',
  note_cap: 'over the `review.notes` limit',
  pre_existing: 'on code this PR did not change',
  memory_suppression: 'hidden by a memory suppression',
  static_signal_match: 'a CI tool reports the same line',
  unsettled_check: 'a tool check could not confirm it',
  not_checked: 'nothing proves it and no tool check ran on it',
  no_proof: 'it cites no lines that prove it',
} as const;
export type UnpostedReason = keyof typeof UNPOSTED_REASONS;
/** Why nothing proves a warning: a check ran and settled nothing, the round's checks did not reach it, or no check could decide and no line is cited. */
const UNPROVEN_REASONS = ['unsettled_check', 'not_checked', 'no_proof'] as const satisfies readonly UnpostedReason[];
export type UnprovenReason = typeof UNPROVEN_REASONS[number];

/** How a blocker or a warning was checked, with the words that say it to a reader. */
export const CHECK_STATUSES = {
  proven: 'proven from the cited lines',
  confirmed: 'confirmed with tools',
  unconfirmed: 'not confirmed',
} as const;
export type CheckStatus = keyof typeof CHECK_STATUSES;

/** Whether the review leaves `finding` out because nothing proves it. */
export function leftOutUnproven(finding: Pick<Finding, 'unpostedReason'>): boolean {
  return UNPROVEN_REASONS.some(reason => reason === finding.unpostedReason);
}

/** Where a round put a finding: a thread of its own, the review body, an earlier thread that carries it, or the round record only. */
export type PostedPlace = 'thread' | 'body' | 'earlier_thread' | 'record';

/** What was cited to back a finding. */
export interface FindingEvidence {
  /** What the reviewer read or searched and what it showed, one short line each. */
  checks: string[];
  /** The `file:line` or `file:start-end` locations that show the failure. A blocker without them is posted as a warning at most. */
  proof: string[];
  /** The lines of related repos that show the failure, as `owner/name:path:line`. Only a check adds them, when it adds its lines to `proof`. */
  relatedProof?: string[];
  /**
   * Set when the finding says something is missing or handled nowhere: the search that came back empty, or an empty
   * string when the reviewer cited none. Such a claim never blocks on its own.
   */
  emptySearch?: string;
}

/** Whether `evidence` cites anything: a check, a proving line, in the PR or in a related repo, or an empty search. */
export function citesEvidence(evidence: FindingEvidence | undefined): boolean {
  return !!evidence && (evidence.checks.length > 0 || evidence.proof.length > 0 || !!evidence.relatedProof?.length || !!evidence.emptySearch);
}

/** What a reviewer had checked of a suspicion when it wrapped up, and what was left. */
export interface OpenLead {
  checked: string;
  left: string;
}

/** Returns `lead` with a stand-in for each part its reviewer left empty, so text built from it never shows an empty value. */
export function leadText(lead: OpenLead): OpenLead {
  return { checked: lead.checked || 'nothing', left: lead.left || 'not said' };
}

/**
 * How an open lead ended in a round: `confirmed` and posted, `disproved` by the judge's tools, `dropped` by the judge,
 * `unsettled` by the tools, or `not_checked` because it went to no check and was only listed. A `disproved` lead is
 * still posted, with `RoundLead.posted` set, when a disproof cannot drop it: a blocker, or a finding that `breaksRule`.
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
export interface InPrSuppression extends ThreadGrade {
  fingerprint: FindingFingerprint;
  reason: InPrSuppressionReason;
  /**
   * Login of the commenter whose reply triggered an `agree-reply` suppression.
   * Absent for `resolved-thread` reasons. Used for audit-log attribution.
   */
  authorLogin?: string;
  /** Set when the PR author alone could not clear the thread. Only such an entry hides a security finding. */
  guarded?: boolean;
}

export type ReviewVerdict = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

/** How a review round ended. Each outcome posts one review event, see `OUTCOME_VERDICT` in `review.ts`. */
export type RoundOutcome = 'READY' | 'ADDRESS_FIRST' | 'INCOMPLETE' | 'NOT_CONVERGING';

/** Blockers a human has to settle, posted with a `NOT_CONVERGING` outcome. */
export interface NeedsHuman {
  /** `repeated`: a blocker came back after a fix was claimed for it. `budget`: the last automatic round the round cap allows still has one open. */
  cause: 'repeated' | 'budget';
  blockers: VerdictTraceEntry[];
}

export type VerdictReason = 'required_present' | 'prior_unaddressed' | 'warnings_present' | 'only_notes' | 'verdict_reader';

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
  /** Open leads below blocker, which the review body lists as not finished checking and never posts. */
  openLeads?: Finding[];
  /** How each open lead of the round ended, carried-over ones included. */
  leads?: RoundLead[];
  threadEvaluations?: ThreadEvaluation[];
  plannerResult?: PlannerResult;
  /** The effort the judge and its refuter ran at: a set `judge.effort`, else the planner's pick, else `high`. */
  judgeEffort?: EffortLevel;
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
  /** Pre-existing findings not worth posting, such as notes. Only the round record keeps them. */
  unpostedPreExisting?: Finding[];
  /** The findings the review leaves out, each with `unpostedReason`. Only the round record keeps them. */
  unposted?: Finding[];
  /**
   * The warnings an earlier round listed only in its review body, which this round lists again in one short list. No
   * finding of this round names them, and the line each points at still reads as it did. They are no findings of the
   * round, so they never change its verdict.
   */
  carried?: FindingFingerprintEntry[];
  /** The warnings an earlier round carried or listed in its body that this round no longer lists, each with the reason. */
  carriedEnded?: CarriedEnd[];
  /** Set when a later round tagged `origin` without the PR's change at the last reviewed round, so no finding reads `reviewed`. */
  originsWithoutPrior?: true;
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
  /** Each sweep the round's findings started, asked or cut. */
  sweeps?: RoundSweep[];
  /** The statements of the PR text the change relies on, each with how its check ended. */
  prClaims?: RoundPrClaims;
  /** The changed files the push since the last round touched, when an earlier round exists and its diff is known. */
  changedSinceLastRoundCount?: number;
  /** The threads where a fix was claimed: confirmed by an earlier round, counted as resolved, agreed away by someone who may clear them, or gone. */
  fixClaimedThreadIds?: string[];
  inPrSuppressedCount?: number;
  agentResponseLengths?: Map<string, number>;
  /** Aggregated wall-clock duration per agent across all passes/retries. */
  agentDurationMs?: Map<string, number>;
  /** Number of CLI/SDK retries per agent. Zero (omitted) when the first try succeeded. */
  agentRetryCount?: Map<string, number>;
  /** Why each failed attempt of an agent failed, in order, kept when a retry then succeeded. */
  agentWarnings?: Map<string, string[]>;
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
  /** No defect could hide in the change. The trivial verifier reads it alone unless a deeper review or `review.routing` gives it finders. */
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
  /** The tier the finder's calls ask for. */
  effort: EffortLevel;
  /** The tier the finder's model receives, which is below `effort` when the model's scale stops there. The name and the round record show it. */
  sentEffort: EffortLevel;
  /** How many tool calls the finder may make when its client has repository tools. */
  steps: number;
  /** Set on a Deeper review when the model receives no more effort than without one. */
  deeperSameEffort?: true;
}

/** One reader in a review group. `auto` effort is `high` when the triage says `subtle`, else `medium`. A Deeper review runs it at `xhigh`. */
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
  /** The lowest grade of a kept finding that starts a search of the diff for other instances of its defect class. */
  sweep?: SweepMode;
  /** How many notes a review lists at most. */
  notes?: number;
  /** Whether a broken required rule of the instruction files is posted as a warning (`warn`) or blocks (`block`). */
  rules?: RulesMode;
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
  /** A Deeper review ran: two finders on every group, at xhigh effort or one level above a configured effort. */
  deeper?: true;
  /** Finders of a Deeper review whose model receives no more effort than without one. */
  deeperSameEffort?: string[];
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

/** The repository roles a PR author can clear a guarded finding with on their own PR, lowest first. */
export const AUTHOR_CLEAR_ROLES = ['write', 'maintain', 'admin'] as const;
export type AuthorClearRole = typeof AUTHOR_CLEAR_ROLES[number];

export interface ReviewConfig {
  auto_review: boolean;
  auto_approve: boolean;
  /**
   * The lowest repository role with which a PR author may clear a blocker or a security finding on their own PR.
   * Read from the base branch only. `fallbackConfig` sets `admin` while that config cannot be read or loaded.
   * A config without it lets no author clear.
   */
  author_clear_role?: AuthorClearRole;
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
    /** The judge's effort, which its code check follows. `auto` takes the planner's pick, or `high` without one. */
    effort?: EffortLevel | 'auto';
  };
  /** Review groups and how PR classes route to them. Always read from the base branch, so a PR cannot weaken its own review. */
  review?: ReviewRoutingConfig;
  /** Which CI results reviewers read as evidence. Always read from the base branch, so a PR cannot turn it off. */
  static_analysis?: StaticAnalysisConfig;
  /** Public repos the review may read as context. Always read from the base branch, so a PR cannot make Manki fetch another repo. */
  related_repos?: RelatedRepo[];
  /** `skip` reviews a draft PR only on request, `review` reviews it automatically. A draft review never approves. */
  drafts?: 'skip' | 'review';
  review_passes?: number;
  convergence?: {
    /**
     * Hard cap on the number of automatic review rounds since Manki last approved the PR. After the last round,
     * automatic review is paused until a review is started by hand. `0` disables the cap.
     */
    max_auto_rounds?: number;
    /**
     * Automatic rounds a review started by hand turns back on while automatic review is paused, when the cap allows fewer.
     * `0` grants none, so after a round-cap pause a review started by hand reviews only its own round.
     */
    rounds_after_restart?: number;
    /** Glob patterns for test files. Notes on these paths are dropped on round 2+. */
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

/**
 * `reference`: a repo this one implements or ports, such as a protocol. `consumer`: a repo that depends on this one.
 * `dependency`: a repo this one depends on, read at the `ref` this one pins.
 */
export const RELATED_REPO_KINDS = ['reference', 'consumer', 'dependency'] as const;
export type RelatedRepoKind = (typeof RELATED_REPO_KINDS)[number];

export interface RelatedRepo {
  /** `owner/name` of a public repo on github.com. */
  repo: string;
  kind: RelatedRepoKind;
  /** Branch, tag or full commit hash to read. Defaults to the repo's default branch. */
  ref?: string;
  /** Paths or globs to fetch, relative to the repo root, next to the root `AGENTS.md` and `CLAUDE.md`. Defaults to the whole repo. */
  paths?: string[];
}

/** The related repos one review round offers its reviewer tools, each fetched on first use. */
export interface RelatedRepoTools {
  repos: RelatedRepo[];
  /** Directory the repos are cloned into, one `owner/name` directory each. A workflow can keep it between runs with `actions/cache`. */
  cacheDir: string;
  /** The round's own directory, where the tool servers record which repo one of them fetched or failed to fetch. */
  stateDir: string;
  /** The guide file at the root of each repo fetched before the finders run, by `owner/name`. Only the prompt uses it. */
  guides?: Record<string, string>;
  /**
   * Reads each repo as it was at this ISO 8601 time: the newest commit made by then on the first-parent history of
   * its `ref`. Unset reads the newest commit, as a pull request round does.
   */
  asOf?: string;
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
export interface OpenThread extends FindingMetadata, ThreadGrade {
  threadId: string;
  threadUrl?: string;
  title: string;
  file: string;
  line: number;
  isSecurity?: boolean;
  /**
   * Snippet of the current source around `line` (line ± a small window). Lets
   * the judge ground its addressed/not-addressed decision in the actual code,
   * not just the thread title. `'(file removed)'` when the file no longer
   * exists at the head commit.
   */
  currentCode?: string;
  /** Manki's latest answer to a developer in the thread, such as a "Fixed." reply with its evidence. */
  answer?: string;
  /**
   * The latest reply in a guarded thread, when the PR author or someone with write access wrote it. It is untrusted
   * text: a claim the judge answers, never evidence.
   */
  authorReplyText?: string;
  /**
   * For an outdated thread, the code around its finding on the commit it was posted on, `postedCommit`. `currentCode`
   * then shows where that code sits now, in the file `movedTo` names when the code left the thread's own. When
   * `postedCodeGone` says it is not found, `currentCode` shows the head's code near the same line.
   */
  postedCode?: string;
  postedCommit?: string;
  postedCodeGone?: boolean;
  /** The one other changed file that holds an outdated thread's posted code unchanged. */
  movedTo?: string;
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
  /** For `partly_addressed`, the severity table cell that gives `grade`, as the judge stated it for what remains. A record from before cells has none. */
  cell?: GradeCell;
  /** The cell the judge stated for what remains when the thread keeps another grade than that cell gives. Only for the record: no prompt shows it. */
  judgeCell?: GradeCell;
}

/**
 * Whether an open thread blocks: by the grade the round records last gave it, or else by its own severity. A recorded
 * blocker always blocks, and a lower recorded grade never lowers a security thread. A thread without a severity marker
 * predates them and blocks.
 */
export function threadBlocks(t: { severity: FindingSeverity | 'unknown'; recordedGrade?: FindingSeverity; isSecurity?: boolean }): boolean {
  if (t.recordedGrade === 'blocker') return true;
  return t.recordedGrade && !t.isSecurity ? false : t.severity === 'blocker' || t.severity === 'unknown';
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
  /** The effort the judge runs at. Shown when there is no planner result, which shows it otherwise. */
  judgeEffort?: EffortLevel;
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
  /** The review class and group the round's readers came from, shown in the review header, and the finders a Deeper review gave no more effort. */
  routing?: Pick<TeamRouting, 'class' | 'group' | 'deeperSameEffort'>;
}

/** A finding the judge dropped because a tool check disproved it, with the reason the check gave. */
export type DisprovedFinding = Pick<Finding, 'title' | 'file' | 'line'> & { reason: string };

export interface JudgeDecision {
  title: string;
  severity: FindingSeverity;
  originalSeverity?: FindingSeverity;
  reasoning: string;
  /** Whether the finding is among the round's findings. One the judge kept and a later step took out is not. */
  kept: boolean;
  /** Set on an open lead the judge's tools left unsettled, which is listed as not finished instead of posted. */
  listed?: true;
  /** Why the review leaves out a finding the judge kept. */
  unpostedReason?: UnpostedReason;
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
  /** The runner the round ran on, and what the run took from it before it posted the review. */
  runner?: RoundRunner;
  /** How the diff was split, when it was read in several slices. */
  slicing?: RoundSlicing;
  /** The instruction files the round read from the base branch, in the order the prompts print them. */
  instructions?: RoundInstructions;
  /** The configured related repos, with the outcome of each fetch. */
  relatedRepos?: RoundRelatedRepo[];
  /** What the finders were shown as uses outside the diff. */
  usesOutsideDiff?: RoundUses;
  /** The open PRs and issues that may relate to this PR, with their classification. */
  relatedWork?: RoundRelatedWork;
  /** Each sibling comparison the round found, asked or cut. */
  comparisons?: RoundComparison[];
  /** Each sweep the round's findings started, asked or cut. */
  sweeps?: RoundSweep[];
  /** The statements of the PR text the change relies on, each with how its check ended. */
  prClaims?: RoundPrClaims;
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

/** The machine a run used, and what the run took from it. */
export interface RoundRunner {
  /** `github-hosted` or `self-hosted`, as the runner reports it. */
  environment?: string;
  os: string;
  arch: string;
  cpus: number;
  /** The machine's memory. */
  memoryBytes: number;
  /** The container's memory limit, when it is below the machine's memory. */
  memoryLimitBytes?: number;
  /** Time from the start of the workflow run until Manki started: the wait for a runner and the job's steps before Manki. */
  queuedMs?: number;
  /** The most resident memory the action and its child processes held in one sample. Missing where processes cannot be listed. */
  peakMemoryBytes?: number;
  /** The most model CLI processes that ran at the same time. */
  peakCliProcesses: number;
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
  /** Set when the round ended incomplete. A later round does not read the record as an earlier round. */
  incomplete?: true;
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
  /** A Deeper review: two finders on every group, at xhigh effort or one level above a configured effort. */
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
  judgeNotes?: string;
  refutation?: Refutation;
  pairRefutation?: Refutation;
  /** How the finding's severity changed until it was dropped. */
  gradePath?: GradeStep[];
  /** Mirrors `Finding.gradeIfConfirmed`. */
  gradeIfConfirmed?: FindingSeverity;
  /** Mirrors `Finding.judgeIfConfirmed`. */
  judgeIfConfirmed?: 'blocker' | 'warning';
  /** Mirrors `Finding.doubts`. */
  doubts?: Doubt[];
  /** Mirrors `Finding.cell`. A dropped finding has one only when a later stage dropped it. */
  cell?: GradeCell;
  /** Mirrors `Finding.rule`. */
  rule?: Finding['rule'];
}

export interface RoundAgentMetric {
  name: string;
  findingsRaw?: number;
  findingsKept?: number;
  durationMs?: number;
  status?: 'success' | 'failed';
  responseLength?: number;
  /** Why each failed attempt of the agent failed, in order. A retry that then succeeded leaves the reason here. */
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
  /** The effort the judge ran at, set or picked by the planner. */
  effort?: EffortLevel;
  /** Findings the judge dropped. The kept ones are in `RoundFindings.entries`. */
  dropped?: RoundJudgeDrop[];
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
   * and ratchets note priors via `applyCrossRoundSuppression`;
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
  /** The threads where a fix was claimed, which a blocker coming back counts against. Empty when there is none. */
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
   * Count of notes dropped by the round-2+
   * test-file suppressor. Returned from `runReview` but previously
   * never written into `RoundContext`.
   */
  testNitSuppressedCount?: number;
  /** Notes dropped because a CI tool already reports a result on the same file and line. */
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
  /** Guarded threads the PR author cleared with a role that `author_clear_role` allows. Omitted when none. */
  securityOverrides?: SecurityOverride[];
}

/** A blocker or security finding the PR author cleared on their own PR, with a role that `author_clear_role` allows. */
export interface SecurityOverride {
  /** Review thread ID. */
  thread: string;
  login: string;
  /** The author's repository role that allowed it. A record from before the role was stored has none. */
  role?: AuthorClearRole;
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
   * The findings Manki recorded without posting them: pre-existing ones, and notes with an `unpostedReason`. Nothing that
   * reads posted findings sees them.
   */
  unposted?: FindingFingerprintEntry[];
  /** Mirrors `ReviewResult.carried`. Each entry keeps the `citedLine` of the round that listed it, and `raisedIn`. */
  carried?: FindingFingerprintEntry[];
  /** Mirrors `ReviewResult.carriedEnded`. */
  carriedEnded?: CarriedEnd[];
  /** Mirrors `ReviewResult.originsWithoutPrior`. */
  originsWithoutPrior?: true;
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
  /** Mirrors `Finding.checkStatus`. */
  checkStatus?: CheckStatus;
  /** Tags applied by the judge (e.g. `OWN_PROPOSAL_TAG`, `SECURITY_TAG`). Preserves the exact string constants from `Finding.tags`. */
  tags?: string[];
  /** Pre-demotion severity, when the judge demoted the finding. Mirrors `Finding.originalSeverity`. */
  originalSeverity?: FindingSeverity;
  /** Mirrors `Finding.reviewerSeverity`. */
  reviewerSeverity?: FindingSeverity;
  /** Whether a tool confirmed or contradicted the finding, or was silent. Mirrors `Finding.toolEvidence.status`. */
  toolEvidence?: ToolEvidenceStatus;
  /** Tool that reported the finding. Mirrors `Finding.toolSource`. */
  toolSource?: string;
  /** New code or code an earlier round reviewed. Mirrors `Finding.origin`. */
  origin?: FindingOrigin;
  /** Mirrors `Finding.raisedIn`. */
  raisedIn?: number;
  /** Mirrors `Finding.sameAs`. */
  sameAs?: string;
  /** Mirrors `Finding.relisted`. */
  relisted?: boolean;
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
  /** Mirrors `Finding.judgeIfConfirmed`. */
  judgeIfConfirmed?: 'blocker' | 'warning';
  /** Mirrors `Finding.doubts`. */
  doubts?: Doubt[];
  /** Mirrors `Finding.cell`. A record from before cells has none. */
  cell?: GradeCell;
  /** Mirrors `Finding.judgeCell`. */
  judgeCell?: GradeCell;
  /** Mirrors `Finding.gradePath`. */
  gradePath?: GradeStep[];
  /** The reviewer's pre-existing claim kept by the judge, and how it was checked against the diff. */
  preExisting?: { reason: string; check: PreExistingCheck };
  /** Mirrors `Finding.rule`. */
  rule?: Finding['rule'];
  /** Mirrors `Finding.unpostedReason`. */
  unpostedReason?: UnpostedReason;
  /**
   * Where the round put the finding. Records written before this field carry none. A finding GitHub refused as a
   * thread falls back to the body and is recorded as `body`.
   */
  posted?: PostedPlace;
  /** The description of a blocker recorded as `body`, which a later round posts as a thread. */
  description?: string;
  /**
   * Set on a warning the round listed only in its review body, so a later round can tell whether the place still reads
   * the same. A warning without a line, or on a line the round could not read, has none.
   */
  citedLine?: CitedLine;
  /**
   * Set on a carried warning: the line its `citedLine` is on at the head of the round that carried it, when exactly one
   * place of the file reads like it. `fingerprint` keeps the line of the round that listed the warning.
   */
  currentLine?: number;
}

/** The place a finding points at, as its file read at the head of the round that listed it. */
export interface CitedLine {
  /** A hash of the line with the line before and the line after it, each without the whitespace around it. */
  hash: string;
  /** How many places of the file read the same. */
  count: number;
}

/**
 * Why a warning carried from an earlier review body is no longer listed: its line reads differently or its file is gone
 * (`line_changed`), or a finding the judge graded this round names it. That finding is listed (`restated`), a note the
 * review leaves out (`hidden_note`), dropped by the judge (`judge_dropped`) or left out by a later step (`left_out`).
 * A warning left out because nothing proves it ends none.
 */
export type CarriedEndReason = 'line_changed' | 'restated' | 'hidden_note' | 'judge_dropped' | 'left_out';

export interface CarriedEnd {
  /** The fingerprint key of the warning. */
  key: string;
  reason: CarriedEndReason;
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
  /** How each related repo fared in a thread reply whose tools could read them. */
  relatedRepos?: RoundRelatedRepo[];
  /** What a thread reply that settles the finding decided. */
  decision?: ReplyDecision;
  /** The statements of the developer's reply that a thread reply checked, in the order it lists them. */
  statements?: ReplyStatementRecord[];
  /** How many statements a thread reply left unchecked because the developer's reply held more than it checks. */
  uncheckedStatements?: number;
  /** How many statements a thread reply did not list because their quote is not in the developer's reply, or repeats one. */
  droppedStatements?: number;
}

/** Why a thread reply could not check a statement. The first two are the model's answer, the rest come from Manki's own checks. */
export type UncheckedReason =
  | 'outside_code' | 'not_reachable'
  | 'no_line' | 'search_term' | 'not_related' | 'not_fetched' | 'no_checkout' | 'search_failed' | 'search_found' | 'search_cut';

/** How one statement of a developer's reply fared. It holds no words of the developer and no search term. */
export interface ReplyStatementRecord {
  status: 'confirmed' | 'contradicted' | 'not_checkable';
  /** The lines the status rests on, each checked to exist: `path:line` of the PR, or `owner/name:path:line`. */
  places?: string[];
  /** Where Manki's own search found no line: `owner/name`, or `pr` for the PR's repository. */
  searched?: string;
  why?: UncheckedReason;
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
  perStage?: Partial<Record<'planner' | 'reviewer' | 'compare' | 'claims' | 'claim_terms' | 'claim_check' | 'sweep' | 'judge' | 'dedup' | 'verdict' | 'related' | 'translate', RoundUsageStage>>;
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
