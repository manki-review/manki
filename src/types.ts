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
const SEVERITY_FIELDS: ReadonlySet<string> = new Set(['severity', 'originalSeverity', 'reviewerSeverity', 'lowestReviewerSeverity', 'gradeIfConfirmed', 'recordedGrade', 'peakGrade']);

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
export const RESOLVED_THREAD_SUPPRESSED_TAG = 'suppressed-by-resolved-thread' as const;

export const OWN_PROPOSAL_TAG = 'own-proposal-followup' as const;
export const IN_PR_SUPPRESSED_TAG = 'suppressed-in-pr' as const;
/** Marks a warning that no longer blocks at this round. It is listed in the review body instead of posted as a thread. */
export const FOLLOW_UP_TAG = 'follow-up' as const;
/** Names the verdict reader as the reviewer of the blockers it reports. */
export const VERDICT_READER_NAME = 'Verdict reader';
/** Names the scope reader as the reviewer of the warnings `review.scope_blocks` posts. */
export const SCOPE_READER_NAME = 'Scope reader';
/** The title of the warning `review.scope_blocks` posts for a usefulness doubt. Fixed, so a repeat folds into its thread. */
export const SCOPE_DOUBT_TITLE = 'This change may not be useful as it stands';
/** The title of the warning `review.scope_blocks` posts for a split. Fixed, so a repeat folds into its thread. */
export const SCOPE_SPLIT_TITLE = 'This PR mixes topics that belong in separate PRs';
/**
 * Whether a thread is the scope reader's: tied to no file and raised by it. The reader judges the whole PR, so its thread
 * needs no line on where it is posted.
 */
export function isScopeThread(file: string | undefined, reviewers: readonly string[] | undefined): boolean {
  return !file && !!reviewers?.includes(SCOPE_READER_NAME);
}
/** Whether `finding` is the split the scope reader proposes. */
export function isScopeSplit(finding: Pick<Finding, 'title' | 'reviewers'>): boolean {
  return finding.reviewers.includes(SCOPE_READER_NAME) && finding.title === SCOPE_SPLIT_TITLE;
}
/** Returns the reviewer name of a round's sweep number `n`, which the findings of that sweep carry. */
export const sweepName = (n: number): string => `Sweep ${n}`;
/** Whether `reviewer` is the name of a sweep. */
export const isSweepName = (reviewer: string): boolean => /^Sweep \d+$/.test(reviewer);
/** Returns the reviewer name of a round's second read number `n`, which its findings and calls carry. */
export const secondReadName = (n: number): string => `Second read ${n}`;
/** Whether `reviewer` is the name of a second read. */
export const isSecondReadName = (reviewer: string): boolean => /^Second read \d+$/.test(reviewer);
/** Whether only second reads reported `finding`, so no finder graded it. */
export const bySecondReadsOnly = (finding: Pick<Finding, 'reviewers'>): boolean => finding.reviewers.length > 0 && finding.reviewers.every(isSecondReadName);
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

/**
 * Whether a step that leaves out notes may leave the finding out of the review: only a note, and never a security
 * finding, a tool alert or a note the other finder's vote lowered from a warning (`votedDown`).
 */
export function canLeaveOut(f: Finding): boolean {
  return isNote(f.severity) && !f.toolSource && !isSecurityFinding(f.tags, f.reviewers) && !votedDown(f);
}

/** Whether the other finder's vote lowered `f` to a note, which stays in the review so one vote never removes a warning. */
export function votedDown(f: Pick<Finding, 'severity' | 'gradePath'>): boolean {
  return isNote(f.severity) && !!f.gradePath?.some(step => step.by === 'other_finder' && step.to === 'note');
}

/**
 * Marks a finding on lines outside every hunk of the PR's diff, which never blocks unless it is a security finding. It
 * also marks a finding whose failure the origin checks found at the PR's base by `foundOnBase`, which never blocks.
 */
export const PRE_EXISTING_TAG = 'pre-existing' as const;
/** Marks a blocker posted as a warning because nothing cited the lines that prove it. */
export const UNPROVEN_TAG = 'unproven-blocker' as const;
/** Marks a blocker posted as a warning because it claims a build, type or test failure that no CI result on the commit reports. */
export const UNBUILT_TAG = 'unconfirmed-build-claim' as const;
/**
 * Marks a blocker posted as a warning because every refuter disproved it, or the other finder's vote declined it. Its
 * thread is guarded as a security finding's is: only a fix or someone allowed to clear it lifts it, never the PR
 * author's answer alone.
 */
export const DISPROVED_TAG = 'disproved-blocker' as const;

/** Whether the thread of a finding is guarded as a security finding's is: a security finding, or one `DISPROVED_TAG` marks. */
export function isGuardedFinding(tags: string[] | undefined, priorReviewers: ReadonlyArray<string | undefined> = []): boolean {
  return isSecurityFinding(tags, priorReviewers) || !!tags?.includes(DISPROVED_TAG);
}

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
  /** The lowest severity a reviewer gave the finding or a duplicate merged into it. Set only when the reviewers split on the grade. */
  lowestReviewerSeverity?: FindingSeverity;
  /**
   * Set when two or more finders ran and one of them alone reported the finding, with no other check beside it. Its
   * blocker cell then needs a confirmed consequence, as one that not every finder filed as a blocker does. Such a blocker
   * or warning gets the other finder's vote (`otherFinderVote`), and such a note follows the others of its group.
   */
  soleFinder?: boolean;
  /** Set when the judge graded the finding a blocker without a doubt and Manki held it at a warning only because it is `soleFinder`. */
  soleHeld?: true;
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
  /**
   * ID of the open thread of an earlier finding this one restates but may not join, since that thread is graded below
   * it or lacks its guard. Once this finding has a thread of its own, Manki points the earlier thread there and resolves it.
   */
  raises?: string;
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
  /** Whether the tool, its rule or the dependency review behind a tool alert names a security problem, so no disproof lowers the alert. */
  securityAlert?: boolean;
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
  /**
   * On a `testing` finding, the `file:line` of a changed line whose removal or reversal no existing test would catch, as
   * the judge named it, or `REVERT_CAUGHT` when the finding claims such a gap and an existing test already catches it.
   */
  revertGap?: string;
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
   * The refuter checks the finding, and a confirmation of every doubt gives it this grade. A blocker cell that not every
   * finder filed as a blocker or that is `soleFinder`, that is no security finding and that restates no earlier blocker needs more: every
   * check confirms the defect and a `consequence` premise. Before its checks, `refuteBlockers` sets `warning` here on
   * such a finding without a `consequence` premise. On a finding that `isRareClaim` it is the grade of
   * the `normal` column, which no confirmation gives. On a finding the judge dropped with a `drop` premise, it is the
   * grade of the cell the judge stated for when that premise is false.
   */
  gradeIfConfirmed?: FindingSeverity;
  /** The judge's own answer for `gradeIfConfirmed`, on a finding with a doubt. Unset when it stated none. Only for the record. */
  judgeIfConfirmed?: 'blocker' | 'warning';
  /** The premises the judge doubts, which the refuter checks one by one. */
  doubts?: Doubt[];
  /** The sequence of events in normal use that sets off the failure, as the judge named it. Unset when it named none. */
  trigger?: string;
  /** How the judge's attempt to refute the finding with tools came out. Set on blockers, open leads, findings lowered for want of proof and findings checked for a doubt the judge named. */
  refutation?: Refutation;
  /** How the second refuter, on `models.second_refuter`, came out. Set beside `refutation` when that model checked the finding. */
  pairRefutation?: Refutation;
  /** The origin checks of whether the PR caused the failure. Set on blockers and warnings the round checked. */
  originCheck?: OriginCheck;
  /** The vote of a finder that did not report the finding, which `otherFinderVotes` asks on a `soleFinder` blocker or warning. */
  otherFinderVote?: OtherFinderVote;
  /** How important the finding is, set on a warning that `rateWarnings` rated in this round or an earlier one. */
  importance?: Importance;
  /** The line of an origin answer's `fixedElsewhere`, on a pre-existing finding posted as a note because the PR fixes the same failure there. */
  fixedElsewhere?: string;
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
  /** The open issue or PR of related work that describes this finding, which the review shows with it. It changes nothing else. */
  trackedIn?: Pick<RelatedItem, 'kind' | 'number'>;
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

/** How a broken required rule is graded, the `review.rules` setting: `auto` by its damage alone, `warn` at least a warning, `block` a blocker. */
export const RULES_MODES = ['auto', 'warn', 'block'] as const;
export type RulesMode = typeof RULES_MODES[number];

/** Returns the grade a confirmed rule finding gets under `rules`: a warning with `warn`, a blocker with `block`, and none with `auto`, the default. */
export const ruleGrade = (rules?: RulesMode): FindingSeverity | undefined => (rules === 'block' ? 'blocker' : rules === 'warn' ? 'warning' : undefined);

/** Whether `finding` breaks a required rule that gives it a grade under `rules`, which `auto` never does. */
export function gradedByRule(finding: Pick<Finding, 'rule'>, rules?: RulesMode): boolean {
  return breaksRule(finding) && !!ruleGrade(rules);
}

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
  /** The login that opened it. */
  author?: string;
  /** Set when `hasWriteAccess` confirms that a person who can push to the repository opened it. Only such an item tracks a finding. */
  byWriter?: true;
  /** Unset until the dedup model classified it, and when the classification failed. */
  relation?: RelatedRelation;
  /** The dedup model's one line of reasoning. */
  reason?: string;
}

/** The open PRs and issues a round looked at, and why any source was left out, such as a rate-limited search. */
export interface RelatedWork {
  items: RelatedItem[];
  /** The open issues Manki's answers named when they settled a thread without a fix. Only the deferral check reads them, so none is classified or listed. */
  tracking?: RelatedItem[];
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
  /** For a `dependency` repo without a configured `ref`, the lockfile that locked its `ref`. */
  lockfile?: string;
  /** For a `dependency` repo without a configured `ref`, why no lockfile decided it, so it was read at its default branch. */
  unlocked?: string;
  /** The time the round read the repo as of, when it did not read the newest commit. */
  asOf?: string;
}

/** A dependency's published source that the round's reviewer tools read, or tried to read. */
export interface RoundDependencySource {
  /** The package as `<registry>/<name>@<version>`, as a check cites its lines. Without a version when none could be resolved. */
  package: string;
  /** The registry it comes from, such as `crates.io` or `npm`. */
  registry: string;
  name: string;
  version?: string;
  /** Where the version comes from: a lockfile that locks it, or a manifest's requirement it was resolved from. */
  source?: 'lockfile' | 'requirement';
  /** That lockfile or manifest, or the file that made Manki refuse the package, as a path in the PR's repository. */
  file?: string;
  /** The manifest's requirement, when the version was resolved from one. */
  requirement?: string;
  /**
   * `fetched`, `failed` with the `reason`, `mismatch` when its archive did not match its checksum and was not read, or
   * `refused` with the `reason` when the code the PR uses is not the registry's archive, such as a patched or git package.
   */
  status: 'fetched' | 'failed' | 'mismatch' | 'refused';
  reason?: string;
  /** How long the fetch took, when it ended. */
  durationMs?: number;
  /** Tool calls that read the package, over every call of the round. */
  reads?: number;
  /** Those tool calls by the stage that made them, with the refuters as `refute` and `refute_pair`. */
  readsByStage?: Record<string, number>;
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
  /** Why no term was guessed, or the step still running when the lines stopped being waited for. Every claim check then started without lines of the related repos. */
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

/**
 * `follows` the existing places, `differs_with_reason` when the code states why it differs, `differs` when nothing does,
 * and `no_comparable` when fewer than two existing places do the same kind of thing.
 */
export const PATTERN_ANSWERS = ['follows', 'differs_with_reason', 'differs', 'no_comparable'] as const;
export type PatternAnswer = typeof PATTERN_ANSWERS[number];

/** A targeted call comparing changed code with the code beside it, asked alongside the finders. */
export interface RoundComparison {
  /**
   * `field` asks whether a sibling field can hold the item a change looks up, `implementations` compares sibling functions.
   * A related repo kind checks one counterpart of that kind of repo. `pattern` compares a piece of structure the change
   * adds with how the repository already does the same kind of thing.
   */
  kind: 'field' | 'implementations' | RelatedRepoKind | 'pattern';
  /** The reviewer name its findings carry. */
  reviewer: string;
  /**
   * The changed lookup, or each function compared, as `file:line`. For a counterpart, its lines as `owner/name:path:line`.
   * For a piece of structure, its first line.
   */
  at: string[];
  /** How an answered `pattern` call says the piece compares with the existing places that do the same kind of thing. */
  answer?: PatternAnswer;
  /** The existing places an answered `pattern` call read and compared, as `file:line`, each a line there that the PR does not add. */
  places?: string[];
  /**
   * `failed` when the call failed or its reply did not parse twice, `cut` when the round's cap left it out, `timed_out`
   * when it was still unanswered once the grace after the finders ran out, and `skipped` when a counterpart's or a
   * piece's call had no repository tools to read the code.
   */
  status: 'answered' | 'failed' | 'cut' | 'timed_out' | 'skipped';
  findings?: number;
  /**
   * The findings an answer dropped: for a counterpart, those that cite no existing line of the PR or none of the related
   * repo. For a piece, those that cite fewer than two existing places and no rule, or sit on no line the PR adds.
   */
  dropped?: number;
  /** A digest of everything the call was sent, set on an answered question. */
  inputDigest?: string;
  /** Set when the round kept the answer from `meta.reusedFrom` and did not ask again. */
  reused?: true;
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

/** One more read of the change by a finder's model after the finders, told the location and title of each finding so far. */
export interface RoundSecondRead {
  /** The reviewer name its findings carry, such as `Second read 1`, and the agent of its calls in `usage.llmCalls`. */
  reviewer: string;
  /** The finder whose model, effort and message it reused. */
  finder: string;
  status: 'answered' | 'failed';
  /** The findings it reported, before dedup and the judge. */
  findings?: number;
  /** Of those, the blockers and warnings near no earlier finding of the round. Only these start another read. */
  added?: number;
  /** Why the call failed. */
  error?: string;
}

/** The second reads of a round, and why no further read ran. */
export interface RoundSecondReads {
  reads: RoundSecondRead[];
  /**
   * `nothing_new` when the last read added no blocker or warning, `cap` when the most reads a round allows ran,
   * `failed` when a read failed, `no_time` when the finders had less time left than a read starts with, and
   * `no_reader` when every finder's model reached a limit or was refused this round.
   */
  stop: 'nothing_new' | 'cap' | 'failed' | 'no_time' | 'no_reader';
  /** Set when the round kept the reads from `meta.reusedFrom` and did not read again. */
  reused?: true;
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
  /** A digest of everything the check was sent, set when the check answered. */
  inputDigest?: string;
  /** Set when the round kept the answer from `meta.reusedFrom` and did not check again. */
  reused?: true;
}

/** The claims a round took from the PR text, each with its check. */
export interface RoundPrClaims {
  /** Why no claim was taken from the PR text: the call failed, its reply could not be used or no model is set up for it. */
  skipped?: string;
  /** Statements the PR text holds that the cap on claims left out. */
  cut?: number;
  claims?: RoundPrClaim[];
}

/** A part of the change that corrects a behaviour, as a model listed it from the diff alone. */
export interface ListedFix {
  /** Its changed lines, as `file:start-end` in the new file, each inside a hunk of the diff. */
  at: string[];
  /** The wrong behaviour it is meant to correct, in one sentence. */
  problem: string;
}

/** A fix of the round and how its check ended. */
export interface RoundFix extends ListedFix {
  /** The reviewer name its findings carry. */
  reviewer: string;
  /**
   * `root_cause` when the check found that the fix changes the code that causes the problem, and `workaround` when the
   * cause stays as it was. Each stands only with a cited line that exists, and `workaround` only with one outside the
   * fix. Every other end is `unchecked`. No stage is shown it. A `workaround` the push changed, whose finding stands,
   * keeps an open thread at its lines from closing (`pushedWorkarounds`, `concernsThread`).
   */
  status: 'root_cause' | 'workaround' | 'unchecked';
  /** Why the check gave no answer: as for `RoundPrClaim.call`, and `cut` when the cap on checks left the fix out. */
  call?: 'failed' | 'timed_out' | 'skipped' | 'cut';
  /** Where the problem comes from, as the check stated it. */
  cause?: string;
  /** The input or path that still fails with the fix in place, as the check stated it. */
  stillFails?: string;
  /** What is left to check, as the check stated it. */
  reason?: string;
  /** The existing `file:line` locations the check cited for its status. */
  proof?: string[];
  /** The lines of related repos it cited for that, as `owner/name:path:line`, each in a checkout the round fetched. */
  relatedProof?: string[];
  /** The findings it reported for a `workaround`, before dedup and the judge. */
  findings?: number;
  /** A digest of everything the check was sent, set when the check answered. */
  inputDigest?: string;
  /** Set when the round kept the answer from `meta.reusedFrom` and did not check again. */
  reused?: true;
}

/** The fixes a round listed from the diff, each with its check. */
export interface RoundFixes {
  /** Why no fix was listed: the call failed, its reply could not be used or no model is set up for it. */
  skipped?: string;
  /** Fixes the listing gave past its cap. */
  cut?: number;
  fixes?: RoundFix[];
}

/** A topic the scope reader sees in a PR, with the changed files that belong to it, each whole or as `path:start-end`. */
export interface ScopeTopic {
  name: string;
  files: string[];
  /** For a proposed PR of a split: one or two sentences on what it would contain. Model text, shown only. */
  contents?: string;
  /** For a proposed PR of a split: the numbers of the other proposed PRs it needs merged first, counted from 1. */
  needs?: number[];
}

/** How the scope reader judged the PR as a whole on a round. */
export interface RoundScope {
  /**
   * Why the reader did not run: a trivial change, or a diff that did not change since `since`, the last round it ran on.
   * An `unchanged` round carries that round's answer.
   */
  skipped?: 'trivial' | 'unchanged';
  since?: number;
  /** SHA-256 over the PR title and description the answer was given for, its stated purpose. */
  purpose?: string;
  /** SHA-256 over the linked issues the answer was given for. */
  issues?: string;
  /** SHA-256 over where each hunk sits on the head side, set when `split` names a line range, which a rebase can move. */
  hunks?: string;
  /** The `codeDigest` of the files a doubt's `proof` cites, when the reader checked them in a checkout. */
  cited?: string;
  /** Why the call failed or its reply could not be used. */
  failed?: string;
  /** The reader's doubt that the change is useful, kept only with `proof`. With `review.scope_blocks`, also only once the refuter confirms it. */
  doubt?: string;
  /** The lines that back `doubt`, each checked to exist. */
  proof?: string[];
  /** The distinct topics the reader sees. */
  topics?: ScopeTopic[];
  /** The proposed PRs of a split, each with its files and line ranges, kept only when every hunk of the diff is in exactly one of them. */
  split?: ScopeTopic[];
  /**
   * The parts of the answer the code check or the refuter left out, with why. Neither shows nor holds the approval. A
   * doubt the refuter left unsettled keeps its text and lines here, so a later round on the same diff checks it again.
   */
  dropped?: Array<{ part: 'doubt' | 'split'; reason: string; doubt?: string; proof?: string[] }>;
  /** Set when `review.scope_blocks` posted the kept parts as warnings instead of listing them in the review body. */
  warned?: true;
}

export interface RoundSlicing {
  /** The changed files in each slice. A file split across slices counts in each. */
  files: number[];
  /** The verdict reader's answer on each slice, when it ran. */
  reader?: Array<{ verdict: VerdictReport['verdict']; blockers: number }>;
}

/** What changed a finding's severity. */
export type GradeChange =
  | 'judge' | 'rule' | 'unproven' | 'build_claim' | 'refutation' | 'in_pr_suppression' | 'own_proposal' | 'ratchet'
  | 'resolved_thread' | 'pre_existing' | 'own_fix' | 'other_finder' | 'unconfirmed_raise';

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

/** Returns the highest grade a finder gave `finding` or a duplicate merged into it, or the lowest one with `lowest`. */
export function finderGrade(finding: Pick<Finding, 'reviewerSeverity' | 'lowestReviewerSeverity' | 'gradePath' | 'severity'>, which: 'highest' | 'lowest' = 'highest'): FindingSeverity {
  const highest = finding.reviewerSeverity ?? finding.gradePath?.[0]?.from ?? finding.severity;
  return which === 'lowest' ? finding.lowestReviewerSeverity ?? highest : highest;
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
 * for that case, or `refuteBlockers` set it because not every finder filed a blocker or one finder alone reported it, and the judge
 * named no `consequence` premise.
 */
export function staysWarningIfConfirmed(f: Pick<Finding, 'gradeIfConfirmed' | 'cell'>): boolean {
  return f.gradeIfConfirmed === 'warning' && isGradeCell(f.cell) && cellGrade(f.cell.row, f.cell.column) === 'blocker';
}

/**
 * Whether the judge graded `f` a blocker, its `pendingGrade` is one, or a later step raised it to one. The grade a
 * finder filed does not count. A finding with no `judge` step kept the grade it came to the judge with.
 */
export function wouldBlockIfTrue(f: Pick<Finding, 'gradeIfConfirmed' | 'cell' | 'gradePath' | 'severity'>): boolean {
  const judged = f.gradePath?.find(step => step.by === 'judge')?.to ?? f.gradePath?.[0]?.from ?? f.severity;
  return pendingGrade(f) === 'blocker' || judged === 'blocker' || !!f.gradePath?.some(step => step.to === 'blocker');
}

/** Whether `applyRefutation` lowered the blocker `finding` because every refuter that ran disproved it. */
export function isDisprovedBlocker(finding: Pick<Finding, 'gradePath'>): boolean {
  return !!finding.gradePath?.some(step => step.by === 'refutation' && step.from === 'blocker');
}

export type RefutationOutcome = 'disproved' | 'confirmed' | 'unsettled';

/**
 * A premise the judge doubts, stated as a fact the code can confirm or disprove. It `decides` either whether the defect
 * exists at all, so a disproof drops the finding, or only which cell the finding belongs in, such as whether normal
 * use or outside input produces the state a finding in the `rare` column needs. A `drop` premise is the reason the judge
 * dropped the finding, about code outside the diff, so the finding stands only when a check disproves it.
 */
export interface Doubt {
  premise: string;
  decides: 'defect' | 'grade' | 'drop';
  /** Set on the `grade` premise about the damage that makes the cell's row a blocker, worded so the blocker needs it true. */
  consequence?: true;
}

/** Whether the judge dropped `f` on a `drop` premise the refuter checks. */
export function restsOnDrop(f: Pick<Finding, 'doubts'>): boolean {
  return !!f.doubts?.some(d => d.decides === 'drop');
}

/**
 * The claim the `rare` column makes on a row where `columnDecidesBlock`, as a premise for the refuter. Manki adds it to
 * every finding in such a cell. The refuter's answer is recorded and never moves the finding to the `normal` column.
 */
export const REACH_DOUBT: Doubt = { premise: 'Normal use or outside input can produce the state this failure needs', decides: 'grade' };

/**
 * Returns the premise that the `trigger` of a finding happens in realistic use, which `doubtTrigger` asks the refuter to
 * check. Without a `trigger` the premise names the sequence of events the finding's description gives.
 */
export function triggerDoubt(trigger: string | undefined): Doubt {
  return { premise: `${TRIGGER_PREMISE}${trigger || 'the sequence of events the description names'}`, decides: 'defect' };
}

const TRIGGER_PREMISE = 'This trigger happens in realistic use: ';

/** Whether `doubt` is a premise `triggerDoubt` words, such as one a later judge names again from an earlier round. */
export function isTriggerDoubt(doubt: Pick<Doubt, 'premise'>): boolean {
  return doubt.premise.startsWith(TRIGGER_PREMISE);
}

/** Returns `doubts` with `REACH_DOUBT` in place of any doubt that words the same premise. */
export function withReachDoubt(doubts: readonly Doubt[] = []): Doubt[] {
  return [...doubts.filter(d => d.premise !== REACH_DOUBT.premise), REACH_DOUBT];
}

/**
 * How a program outside the code the refuter reads behaves, such as an external tool, a package manager, a runtime or a
 * remote service, as a confirmation the refuter gave rests on it.
 */
export interface OutsideBehavior {
  /** The behavior, in the refuter's words. */
  behavior: string;
  /** Whether a cited line of a file the refuter can read states it. A confirmation that rests on an unstated behavior is stored `unsettled`. */
  stated: boolean;
}

/** How a refuter answered one premise the judge doubts. */
export interface PremiseCheck {
  premise: string;
  /** What the doubt decided when the check ran. A record from before this was stored has none. */
  decides?: Doubt['decides'];
  outcome: RefutationOutcome;
  /**
   * Set when the refuter answered that the premise depends on something no code in reach can show, such as how a model
   * or a peer behaves. Its `outcome` is then `unsettled` for every grade, doubt and hold. Only `confirmsCodePath` reads it.
   */
  outsideCode?: true;
  /** Set on a confirmation that rests on outside behavior. A `drop` premise, whose confirmation counts against the finding, keeps its outcome. */
  outside?: OutsideBehavior;
  reason: string;
  proof?: string[];
  /** The lines of related repos that decide it, as `owner/name:path:line`. They can confirm, and never count toward a disproof. */
  relatedProof?: string[];
}

/**
 * How an origin check answered whether a finding's failure is this PR's own: the PR `introduced` it, `worsened` an
 * older one, or the base already failed the same way (`pre_existing`).
 */
export type OriginVerdict = 'introduced' | 'worsened' | 'pre_existing' | 'unsure';

/** One origin check's answer about a finding. */
export interface OriginAnswer {
  verdict: OriginVerdict;
  reason: string;
  /** The lines that show the failure at the head, as the code found them there. */
  head?: string[];
  /** The lines that show the same failure at the base, in git's paths, as the code found them at `commit`. */
  base?: string[];
  /** The PR's base commit that holds the `base` lines. */
  commit?: string;
  /** On a `pre_existing` answer, the line the PR added or changed that fixes the same failure on another path. */
  fixedElsewhere?: string;
  /** The model that answered. */
  model?: string;
}

/** The origin checks of a finding. */
/** The answer of a finder that did not report a `soleFinder` finding, asked for the harm the finding causes. */
export interface OtherFinderVote {
  /** The finder whose model answered. */
  finder: string;
  harm: string;
  /** The realistic situation in normal use where the harm happens. */
  situation: string;
  /** Where the harm happens, as `path:line`, and the code quoted from it. Missing when the answer named no line. */
  line?: string;
  quote?: string;
  /** Whether the answer named no line, or one the head does not hold the quoted code near. */
  declined: boolean;
  model?: string;
}

export const IMPORTANCE_SCORES = ['trigger', 'introduced', 'matters', 'overall'] as const;

/** The scores of a warning, each a whole number from 1 to 10. `trigger` and `matters` decide whether the review leaves it out. */
export interface Importance {
  overall: number;
  /** How easily it is triggered. */
  trigger: number;
  /** How clearly the PR introduces it. */
  introduced: number;
  /** How much it matters when it happens. */
  matters: number;
  /** Why `trigger`, in one sentence of the model. */
  reason?: string;
  /** The `review.min_warning_trigger` its trigger is below. Set on a warning left out with `rare_trigger`. */
  cutOff?: number;
}

/** Whether `value` holds the scores of an `Importance`. */
export function isImportance(value: unknown): value is Importance {
  const scores = value as Record<string, unknown> | null | undefined;
  return IMPORTANCE_SCORES.every(name => Number.isInteger(scores?.[name]) && (scores![name] as number) >= 1 && (scores![name] as number) <= 10);
}

/** Returns the scores of `importance` without its reason. */
export function scoresOf({ trigger, introduced, matters, overall }: Importance): Importance {
  return { trigger, introduced, matters, overall };
}

export interface OriginCheck {
  /** Whether the PR added or changed the flagged line, so the line has no place at the base. */
  lineChanged: boolean;
  answers: OriginAnswer[];
}

/** The outcome of the judge's attempt to refute a finding with tools. */
export interface Refutation {
  /** What the check means for the finding's grade: the answer to the whole finding, or what its `premises` add up to. */
  outcome: RefutationOutcome;
  /** The refuter's own answer whether the defect exists, whatever it found about the premises. A record from before this was stored has none. */
  defect?: RefutationOutcome;
  /** Set when the refuter confirmed the defect resting on outside behavior. */
  outside?: OutsideBehavior;
  /** The lines a confirmation of the defect cites for how normal use triggers the failure and where its result shows. */
  triggerProof?: string[];
  resultProof?: string[];
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
 * Returns what the answer on premise `p` says about its finding. A `drop` premise is the judge's reason to drop the
 * finding, so its disproof backs the finding and its confirmation counts against it.
 */
export function towardFinding(p: Pick<PremiseCheck, 'outcome' | 'decides'>): RefutationOutcome {
  if (p.decides !== 'drop' || p.outcome === 'unsettled') return p.outcome;
  return p.outcome === 'disproved' ? 'confirmed' : 'disproved';
}

/**
 * Returns what `check` says about its finding. It is `disproved` when the refuter answered that the defect does not
 * exist, whatever its `premises` add up to. Otherwise it is the check's `outcome`.
 */
export function outcomeOf(check: Pick<Refutation, 'outcome' | 'defect'>): RefutationOutcome {
  return check.defect === 'disproved' ? 'disproved' : check.outcome;
}

/** Whether the refuter confirmed `answer` resting on outside behavior no cited line states, so it is stored `unsettled`. */
export const restsOnUnstated = (answer: { outside?: OutsideBehavior }): boolean => answer.outside?.stated === false;

/**
 * Returns `check` as the refuter answered it, with each confirmation that `restsOnUnstated` confirmed again. A step that
 * lowers, drops or hides a finding reads this, so such a confirmation still stands against a disproof, only never raises
 * a grade or shows the finding as confirmed.
 */
export function asAnswered(check: Refutation): Refutation {
  if (!restsOnUnstated(check) && !check.premises?.some(restsOnUnstated)) return check;
  const premises = check.premises?.map(p => (restsOnUnstated(p) ? { ...p, outcome: 'confirmed' as const } : p));
  const defect = restsOnUnstated(check) ? 'confirmed' : check.defect;
  // Only a confirmation was stored unsettled, so an outcome confirms again only when every answer it adds up from does.
  const confirms = premises ? premises.every(p => towardFinding(p) === 'confirmed') : defect === 'confirmed';
  return { ...check, outcome: check.outcome === 'unsettled' && confirms ? 'confirmed' : check.outcome, ...(defect && { defect }), ...(premises && { premises }) };
}

/**
 * Returns the `outcome` that `checks` agree on, which decides whether a grade is restored and whether a blocker is
 * lowered. An unsettled check abstains, and a confirmation against a disproof settles nothing. So no check confirms
 * beside one that disproves, be it the finding, the defect or a premise that only decides the grade, read by `towardFinding`.
 * Checks agree on a disproof only when they also do `asAnswered`.
 */
export function agreedOutcome(checks: readonly Refutation[]): RefutationOutcome {
  const outcome = agreedOn(checks);
  return outcome === 'disproved' && agreedOn(checks.map(asAnswered)) !== 'disproved' ? 'unsettled' : outcome;
}

function agreedOn(checks: readonly Refutation[]): RefutationOutcome {
  const votes = new Set(checks.map(r => r.outcome).filter(o => o !== 'unsettled'));
  if (votes.size !== 1) return 'unsettled';
  const [outcome] = votes;
  return outcome === 'confirmed' && checks.some(r => outcomeOf(r) === 'disproved' || r.premises?.some(p => towardFinding(p) === 'disproved')) ? 'unsettled' : outcome;
}

/**
 * Whether `check` asked whether the defect of `finding` exists and confirmed it. A confirmed premise is no such answer.
 * Neither is a confirmation that left a premise that decides whether the defect exists unsettled or, by `towardFinding`,
 * disproved. A premise says what it decided when the check ran. One stored without that is looked up in the doubts of
 * `finding`, and one no doubt names counts as deciding the defect, since nothing shows it only decided the grade.
 */
export function confirmsDefect(check: Refutation, finding: Pick<Finding, 'doubts'>): boolean {
  return check.defect === 'confirmed' && openPremises(check, finding).length === 0;
}

/** Whether a check of `finding` `confirmsDefect` as the refuter answered it (`asAnswered`), whatever another check says. */
export function confirmedByCheck(finding: Pick<Finding, 'refutation' | 'pairRefutation' | 'doubts'>): boolean {
  return [finding.refutation, finding.pairRefutation].some(check => !!check && confirmsDefect(asAnswered(check), finding));
}

/** Returns the premises of `check` that leave the defect of `finding` open, as `confirmsDefect` reads them. */
function openPremises(check: Refutation, finding: Pick<Finding, 'doubts'>): PremiseCheck[] {
  const decides = (p: PremiseCheck): Doubt['decides'] | undefined => p.decides ?? finding.doubts?.find(d => d.premise === p.premise)?.decides;
  return check.premises?.filter(p => towardFinding(p) !== 'confirmed' && decides(p) !== 'grade') ?? [];
}

/**
 * Whether `check` confirmed the defect of `finding` and left open only premises no code in reach can show
 * (`outsideCode`). It decides how the finding reads and never its grade, which only `confirmsDefect` can raise.
 */
export function confirmsCodePath(check: Refutation, finding: Pick<Finding, 'doubts'>): boolean {
  return check.defect === 'confirmed' && openPremises(check, finding).every(p => p.outsideCode);
}

/**
 * Returns the first point a check which confirmed the code path of `finding` left open: a premise about code it left
 * unsettled, or else the outside behavior its confirmation of the defect rested on with no line stating it. Returns
 * none when a check disproved the finding. A check that also disproved a premise the defect rests on contradicts
 * itself, so it names none either.
 */
export function openCodePremise(finding: Pick<Finding, 'doubts' | 'refutation' | 'pairRefutation'>): string | undefined {
  const checks = [finding.refutation, finding.pairRefutation].filter((r): r is Refutation => !!r);
  if (checks.some(check => outcomeOf(check) === 'disproved')) return undefined;
  const codePath = checks.filter(check => asAnswered(check).defect === 'confirmed' && openPremises(check, finding).every(p => p.outcome === 'unsettled'));
  return codePath.flatMap(check => openPremises(check, finding)).find(p => !p.outsideCode)?.premise
    ?? codePath.find(restsOnUnstated)?.outside?.behavior;
}

/** Whether `answer` shows the failure at the base, with lines the code found at the base `commit`. */
function failsOnBase(answer: OriginAnswer): boolean {
  return answer.verdict === 'pre_existing' && !!answer.base?.length && !!answer.commit;
}

/**
 * Returns the origin answer that shows the code at the PR's base fails the same way as `finding`, when two answers on
 * different known models do so (`failsOnBase`) and none says otherwise. One model's answer, read from files the PR
 * author controls, never lowers a blocker, so one answer alone, or two on one model, keep the finding as it is.
 */
export function sameOnBase(finding: Pick<Finding, 'originCheck'>): OriginAnswer | undefined {
  const answers = finding.originCheck?.answers ?? [];
  const models = new Set(answers.filter(failsOnBase).map(a => a.model).filter(Boolean));
  return models.size >= 2 && answers.every(failsOnBase) ? answers[0] : undefined;
}

/**
 * Returns the one origin answer that shows the code at the PR's base fails the same way as `finding`, when `sameOnBase`
 * does not and no answer found the failure the PR's own. On its own it changes no grade. The finding only notes that it
 * may be older than this PR, unless `foundOnBase` accepts one answer for it.
 */
export function oneCheckOnBase(finding: Pick<Finding, 'originCheck'>): OriginAnswer | undefined {
  const answers = finding.originCheck?.answers ?? [];
  if (sameOnBase(finding) || answers.some(a => a.verdict === 'introduced' || a.verdict === 'worsened')) return undefined;
  return answers.find(failsOnBase);
}

/** Whether one origin answer is enough to keep `f` out of the review: a warning or note that would never block and is not guarded (`isGuardedFinding`). */
export function oneAnswerSettles(f: Finding): boolean {
  return f.severity !== 'blocker' && !wouldBlockIfTrue(f) && !staysWarningIfConfirmed(f) && !isGuardedFinding(f.tags, f.reviewers);
}

/**
 * Returns the origin answer that makes `f` pre-existing. Two answers on different models must agree (`sameOnBase`),
 * except on a flagged line the PR left unchanged of a finding `oneAnswerSettles`, where one answer does
 * (`oneCheckOnBase`). A changed line has no place at the base to compare, so it always needs both.
 */
export function foundOnBase(f: Finding): OriginAnswer | undefined {
  if (f.severity === 'ignore') return undefined;
  return sameOnBase(f) ?? (f.originCheck && !f.originCheck.lineChanged && oneAnswerSettles(f) ? oneCheckOnBase(f) : undefined);
}

/** Whether every check in `checks` confirmed the defect and each premise, so none left one open or contradicted itself. */
export function confirmsAll(checks: readonly Refutation[]): boolean {
  return checks.length > 0 && checks.every(r => r.defect === 'confirmed' && r.outcome === 'confirmed');
}

/**
 * Returns the refutation that disproves `finding`, by `outcomeOf`: in a premise the defect rests on, or in its answer
 * whether the defect exists. Returns none when another check backs the finding, since a confirmation against a
 * disproof settles nothing. A check backs it when, `asAnswered`, it does not disprove it and confirmed the defect or, by
 * `towardFinding`, one of the premises.
 */
export function disproof(finding: Pick<Finding, 'refutation' | 'pairRefutation'>): Refutation | undefined {
  const checks = [finding.refutation, finding.pairRefutation].filter((r): r is Refutation => !!r).map(asAnswered);
  const backs = (check: Refutation): boolean => outcomeOf(check) !== 'disproved' && (check.defect === 'confirmed' || !!check.premises?.some(p => towardFinding(p) === 'confirmed'));
  return checks.some(backs) ? undefined : checks.find(check => outcomeOf(check) === 'disproved');
}

/**
 * Returns the refutation that disproves a finding graded below blocker that is `gradedByRule` under `rules`. Such a
 * finding stays in the review whatever the check disproved: the refuter checks whether a failure can happen, not whether
 * a rule is followed, and the same rule break with no damage to check is posted unchecked.
 */
export function overruledDisproof(finding: Pick<Finding, 'severity' | 'rule' | 'refutation' | 'pairRefutation'>, rules?: RulesMode): Refutation | undefined {
  return finding.severity === 'blocker' || finding.severity === 'ignore' || !gradedByRule(finding, rules) ? undefined : disproof(finding);
}

/** `earlier` restates a finding an earlier round listed in its review body, whatever code it sits on. */
export type FindingOrigin = 'new' | 'reviewed' | 'earlier';

/** Why a review leaves out a finding the judge kept, with the words that say it to a reader. The first four are set on a note, `listed_earlier` also on a finding that restates an earlier blocker the round lists again, `no_trigger` on a warning with no realistic trigger, `rare_trigger` on a warning whose trigger is below `review.min_warning_trigger`, and the last three on a warning nothing proves. */
export const UNPOSTED_REASONS = {
  reviewed_code: 'on code an earlier round reviewed',
  listed_earlier: 'listed by an earlier round',
  note_cap: 'over the `review.notes` limit',
  caught_by_test: 'an existing test already fails when the change it names is reverted',
  pre_existing: 'on code this PR did not change',
  memory_suppression: 'hidden by a memory suppression',
  static_signal_match: 'a CI tool reports the same line',
  no_trigger: 'it names no trigger that happens in realistic use',
  rare_trigger: 'its trigger is rated below `review.min_warning_trigger`',
  unsettled_check: 'a check of the code could not confirm it',
  not_checked: 'nothing proves it, and no check of the code ran on it',
  no_proof: 'it cites no lines that prove it',
} as const;
export type UnpostedReason = keyof typeof UNPOSTED_REASONS;
/** The `revertGap` the judge states on a `testing` finding whose missing test an existing test already provides. */
export const REVERT_CAUGHT = 'caught';
/** A step after the judge's grading that can grade a finding the judge kept `ignore`. */
export type LaterDrop = Extract<GradeChange, 'refutation' | 'in_pr_suppression' | 'resolved_thread' | 'ratchet'>;
/** Why a finding the judge kept, or one added after it, is only in the round record. */
export type RecordOnlyReason = UnpostedReason | LaterDrop;
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
  /**
   * The lines of related repos that show the failure, as `owner/name:path:line`. Only a check adds them, when it adds its
   * lines to `proof`, and the check of a related repo counterpart, whose finding cites one.
   */
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
 * still posted, with `RoundLead.posted` set, when a disproof cannot drop it: a blocker, or a finding that `gradedByRule`.
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

/** `agree` when Manki settled the latest reply by a person in the finding's thread, by `replyClassOf`. */
export type AuthorReplyClass = 'agree' | 'none';

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
  threadId?: string;
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

/** Why one attempt of a finder failed. */
export interface FinderError {
  /** The error's class, such as `TimeoutError`, `QuotaError` or `FinderReplyError`. */
  kind: string;
  /** The error's message, as the round's `agentWarnings` keeps it. */
  message: string;
  /** The HTTP status of a failed SDK request. */
  status?: number;
  /** The exit code of a CLI run that failed. */
  exitCode?: number;
  /** Set when the call answered and its reply did not parse. */
  parseFailed?: true;
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
  /** On a round that limits stopped, the latest time, in ISO 8601, at which one of them lifts, when the providers named one. */
  retryAfter?: string;
  /** Findings sent on toward the judge: the finders', and the earlier leads carried over, without the open leads only listed. */
  rawFindingCount?: number;
  /** Tool results sent to the judge as candidate findings, on top of `rawFindingCount`. */
  toolAlertCount?: number;
  /** Findings of the sweep left out of `rawFindingCount`, since the round judged the same problem already. */
  sweepRepeatCount?: number;
  /** Findings of the sweep dropped as repeats of earlier resolved findings, a part of `staticDedupCount` and `llmDedupCount`. */
  sweepDedupCount?: number;
  agentNames: string[];
  allJudgedFindings?: Finding[];
  rawFindings?: Finding[];
  /** Open leads below blocker, which the review body lists as not finished checking and never posts. */
  openLeads?: Finding[];
  /** How each open lead of the round ended, carried-over ones included. */
  leads?: RoundLead[];
  threadEvaluations?: ThreadEvaluation[];
  plannerResult?: PlannerResult;
  /** The planner's own answer, set when a configured `judge.effort` replaced its pick in `plannerResult`. */
  plannerAnswer?: PlannerResult;
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
   * finding of this round names them, the line each points at still reads as it did, and the judge did not find them
   * fixed. They are no findings of the round, so they never change its verdict.
   */
  carried?: FindingFingerprintEntry[];
  /** The fingerprint keys of the warnings `carried` would list that the judge found fixed this round. */
  carriedFixed?: string[];
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
  /** Each dependency's source the reviewer tools read or tried to read, with its version and where that came from. */
  dependencySources?: RoundDependencySource[];
  /** The open PRs and issues that may relate to this PR, classified. Unset when the round looked at none. */
  relatedWork?: RelatedWork;
  /** Each sibling comparison the round found, asked or cut. */
  comparisons?: RoundComparison[];
  /** Each sweep the round's findings started, asked or cut. */
  sweeps?: RoundSweep[];
  /** The reads of the change after the finders. Unset on a round that runs none. */
  secondReads?: RoundSecondReads;
  /** The statements of the PR text the change relies on, each with how its check ended. */
  prClaims?: RoundPrClaims;
  /** The fixes the change holds, each with how its check ended. */
  fixes?: RoundFixes;
  /** Whether the PR is useful and covers one topic, by the scope reader. */
  scope?: RoundScope;
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
  /** The cause of each attempt that failed a finder, in order, kept when a retry then succeeded. */
  agentErrors?: Map<string, FinderError[]>;
  /** The finders asked once more, since their first answer opened none of the files outside the diff that the lists in their message name, or left a unit of the change without a line. */
  agentsAskedAgain?: string[];
  /** The `inputDigest` of each finder whose read finished, run this round or kept from an earlier attempt. */
  agentInputDigests?: Map<string, string>;
  /** The findings each finder of `agentInputDigests` gave, counted when its read finished. */
  agentFindingsReturned?: Map<string, number>;
  /** Set when the round kept results of an earlier attempt: which attempt, and the finders whose findings it kept. */
  reused?: { from: RoundReusedFrom; finders: string[] };
  /** Each finder's line for every unit of the change it was asked to answer for. */
  agentUnitLines?: Map<string, RoundUnitLine[]>;
  /** The units of the change the finders answered for. */
  units?: RoundUnits;
  plannerDurationMs?: number;
  /** Set when the round had no finding, open thread or carried warning to judge, so no judge was called. */
  judgeSkipped?: true;
  judgeDurationMs?: number;
  judgeRetryCount?: number;
  dedupDurationMs?: number;
  /** Every LLM call of the round, in the order each finished. */
  llmCalls?: LLMCall[];
  crossRoundSuppressed?: number;
  /** Set when the judge stage forced every open thread to `not_addressed` because the inter-round diff was known-empty. */
  interRoundDiffEmptyOverride?: InterRoundDiffEmptyOverride;
  testNitSuppressedCount?: number;
  staticSignalMatches?: RoundStaticSignalMatch[];
  verdictTrace?: VerdictTrace;
  /** Team-selection provenance: which path produced this round's roster. */
  plannerSource?: RoundPlannerSource;
  /** Short tag describing the planner fallback path, when one fired. */
  plannerFallbackReason?: string;
  /** Stages that moved to a fallback model, after a safety filter refused them or their model reached a limit. */
  modelFallbacks?: RoundModelFallback[];
  /** The retries, moves to a fallback model and judge calls the round did not start, in the order it decided. */
  notStarted?: RoundNotStarted[];
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
  /** A model id or `provider/model`. */
  model: string;
  /** Unset means `auto`, and `medium` in the `trivial` group. */
  effort?: EffortLevel | 'auto';
  /** One more line for this finder to check, added to its prompt. */
  focus?: string;
}

export interface ReviewGroup {
  reviewers: GroupReviewer[];
  /** Set on the group named `trivial`. Its readers run the quick check and are no finders. */
  quickCheck?: true;
}

/** Conditions a PR must meet to fall in a review class. Every condition set must hold. */
export interface ReviewClassMatch {
  /** Globs or `@` path aliases, one of which some changed file must match. */
  paths_any?: string[];
  /** Answers the triage, after the floor and file rules, must give. */
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

/** The `review` block of `.manki.yml`. Unset keys keep the built-ins. */
export interface ReviewRoutingConfig {
  /** The review groups, each a list of readers: a model id, or a reader with its effort and focus. Replaces the built-in groups. */
  groups?: Record<string, Array<string | GroupReviewer>>;
  /** Adds classes. On a built-in path class, `match.paths_any` adds paths to the built-in rule. */
  classes?: Record<string, { rank?: number; match?: ReviewClassMatch }>;
  /** Group per class, over the built-in routing. */
  routing?: Record<string, string>;
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
  /** Whether a broken required rule of the instruction files is graded by its damage alone (`auto`), at least a warning (`warn`) or blocks (`block`). */
  rules?: RulesMode;
  /** The lowest trigger score from 1 to 10 a warning is posted with. 1 rates none and leaves none out. */
  min_warning_trigger?: number;
  /** Whether the scope reader's doubt or split is posted as a warning that holds the approval, instead of only listed in the review body. */
  scope_blocks?: boolean;
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
  /** What picked the group: the class's route, `full` for a class with no route, the floor or a deeper review. */
  groupSource: 'routing' | 'no_route' | 'floor_escalation' | 'deeper_review';
  /** Highest ranked floor class the PR matched. */
  floor?: string;
  /** Routed group the floor, or a deeper review, moved the PR up from. */
  escalatedFrom?: string;
  /** A Deeper review ran: a group with fewer than two finders moved up to `full`, and every finder ran at xhigh effort or one level above a configured effort. */
  deeper?: true;
  /** Finders of a Deeper review whose model receives no more effort than without one. */
  deeperSameEffort?: string[];
}

export interface TeamRoster {
  finders: Finder[];
  routing: TeamRouting;
  /** Triage after the floor and file rules. */
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
  /**
   * Glob patterns of paths no review stage reads: not in the diff, not in the checkout the tools read. A pattern that
   * names a folder closes every file in it.
   */
  closed_paths?: string[];
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
  instructions: string;
  /** A short phrase naming what the project is, such as `blockchain consensus library`. */
  project?: string;
  memory: {
    enabled: boolean;
    repo: string;
  };
  models?: {
    planner?: string;
    judge?: string;
    /** Model of a second refuter that checks each blocker beside the judge's. Unset means no second refuter. */
    second_refuter?: string;
    dedup?: string;
    /** Model a stage moves to when a safety filter refuses it. Unset means the first model of the `full` group other than the stage's own. */
    fallback?: string;
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
  /**
   * Hard cap on the number of automatic review rounds since Manki last approved the PR. After the last round,
   * automatic review is paused until a review is started by hand. `0` disables the cap.
   */
  max_auto_rounds?: number;
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

/** The related repos, and with `dependencies` the dependencies, one review round offers its reviewer tools, each fetched on first use. */
export interface RelatedRepoTools {
  /** The configured related repos. Empty when the round offers only `dependencies`. */
  repos: RelatedRepo[];
  /** Directory the repos are cloned into, one `owner/name` directory each. A workflow can keep it between runs with `actions/cache`. */
  cacheDir: string;
  /** The round's own directory, where the tool servers record which repo or package one of them fetched or failed to fetch. */
  stateDir: string;
  /** The guide file at the root of each repo fetched before the finders run, by `owner/name`. Only the prompt uses it. */
  guides?: Record<string, string>;
  /**
   * Reads each repo as it was at this ISO 8601 time: the newest commit made by then on the first-parent history of
   * its `ref`. Unset reads the newest commit, as a pull request round does.
   */
  asOf?: string;
  /** How the `ref` of each `dependency` repo that the config gives none was chosen, by `owner/name`. */
  locks?: Record<string, RepoLock>;
  /**
   * Lets the tools also read a dependency the PR's own lockfiles or manifests name, at the version they lock or allow.
   * Only the refuters, the claim checks and the finders are offered it.
   */
  dependencies?: true;
}

/** The lockfile that locked a dependency repo's commit, or why the repo is read at its default branch instead. */
export type RepoLock = { lockfile: string } | { unlocked: string };

export interface StaticAnalysisConfig {
  checks: boolean;
  code_scanning: boolean;
  dependency_review: boolean;
  /** Check runs to wait for on the PR head before reading the results. */
  wait_for_checks: string[];
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
  /** The other files the finding cited as evidence. A push to one counts as a push to the thread, as one to `file` does. */
  evidenceFiles?: string[];
  isSecurity?: boolean;
  /** Whether the thread holds a blocker posted as a warning because every refuter disproved it, which is guarded as a security thread is. */
  disprovedBlocker?: boolean;
  /**
   * Snippet of the current source around `line` (line ± a small window). Lets
   * the judge ground its addressed/not-addressed decision in the actual code,
   * not just the thread title. `'(file removed)'` when the file no longer
   * exists at the head commit.
   */
  currentCode?: string;
  /** Set when the thread's file is at the head but could not be read in full, as it is too large or the read failed. */
  codeUnread?: boolean;
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
   * For `addressed` from the judge, the file it says holds the fix when the push changed neither the thread's file nor a
   * file its finding cited. Once the round grades the threads, only a thread kept open whose fix there two refuters
   * confirmed keeps it.
   */
  fixedIn?: string;
  /**
   * The grade the thread keeps after this round when a partial fix sets or changes it: on `partly_addressed` the grade
   * the remaining damage earns, and on a thread an earlier partial fix lowered, its own grade once it is open again.
   */
  grade?: FindingSeverity;
  /** For `partly_addressed`, the severity table cell that gives `grade`, as the judge stated it for what remains. A record from before cells has none. */
  cell?: GradeCell;
  /** The cell the judge stated for what remains when the thread keeps another grade than that cell gives. Only for the record: no prompt shows it. */
  judgeCell?: GradeCell;
  /**
   * Set when a check confirmed that the push applies the fix the thread's finding suggested, so a blocker restating it
   * was posted as a warning. A later round keeps that cap while its push changes none of the thread's files.
   */
  ownFix?: true;
}

/** Returns what a partial fix leaves open in a thread graded `carried` before it. `remaining` is already safe to post. */
export function partlyFixedNote(remaining: string, grade: FindingSeverity, carried: FindingSeverity): string {
  const regraded = grade === carried ? '' : ` What remains is a ${SEVERITY_NAME[grade]}${carried === 'blocker' ? ', so this thread no longer blocks' : ''}.`;
  return `Still open: ${remaining}${regraded}`;
}

/**
 * Whether an open thread blocks: by the grade the round records last gave it, or else by its own severity. A recorded
 * blocker always blocks, and a lower recorded grade never lowers a guarded thread: a security thread or the thread of a
 * disproved blocker. A thread without a severity marker predates them and blocks.
 */
export function threadBlocks(t: { severity: FindingSeverity | 'unknown'; recordedGrade?: FindingSeverity; isSecurity?: boolean; disprovedBlocker?: boolean }): boolean {
  if (t.recordedGrade === 'blocker') return true;
  return t.recordedGrade && !t.isSecurity && !t.disprovedBlocker ? false : t.severity === 'blocker' || t.severity === 'unknown';
}

/** Whether an open thread that does not block is a warning, read the way `threadBlocks` reads its grade. */
export function threadWarns(t: Parameters<typeof threadBlocks>[0]): boolean {
  if (threadBlocks(t)) return false;
  return t.recordedGrade === 'warning' || (t.severity === 'warning' && (!t.recordedGrade || !!t.isSecurity || !!t.disprovedBlocker));
}

/**
 * Returns the files of the open threads that block or warn, which the code and diffs a review reads put first. With
 * `cited`, also the files their findings cited, since a push to one of them can fix the thread too.
 */
export function fixThreadFiles(threads: ReadonlyArray<Parameters<typeof threadBlocks>[0] & { file: string; evidenceFiles?: string[] }>, cited = false): Set<string> {
  return new Set(threads.filter(t => t.file && (threadBlocks(t) || threadWarns(t))).flatMap(t => [t.file, ...(cited ? t.evidenceFiles ?? [] : [])]));
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
  /** Why a retry or a move to the fallback model of the finder was not started, one line each. */
  notStarted?: string[];
  /** When the finder's call started, in ms since the epoch, for its time so far. A retry starts it again. */
  startedAt?: number;
  /** The tool calls the finder started so far. */
  toolSteps?: number;
  /** Set when the round kept the finder's findings from an earlier attempt and did not run it. */
  reused?: true;
}

/** A step of calls that run beside the finders, or after the judge for the sweeps. */
export type SideCheckKind = 'comparison' | 'related' | 'claim' | 'pattern' | 'fix' | 'sweep' | 'second_read' | 'origin';

/** Hears of the checks of one step as they run. */
export interface CheckProgress<R> {
  /** Called once with how many checks the step asks. */
  started(total: number): void;
  /** Called as each check ends, with its result, or with `undefined` when it made no call. */
  ended(result: R | undefined): void;
}

/** What the judge made of the findings it graded, whatever a later step did with them. `merged` folded into another finding. */
export interface GradedCounts {
  kept: number;
  dropped: number;
  merged: number;
}

/** How one step of side checks is going. */
export interface SideCheckState {
  total: number;
  ended: number;
  findings: number;
  startedAt: number;
  /** Set once every check of the step ended. */
  endedAt?: number;
}

export interface DashboardData {
  phase: 'planning' | 'started' | 'reviewed' | 'complete';
  lineCount: number;
  agentCount: number;
  rawFindingCount?: number;
  judgeInputCount?: number;
  /** Set when the round had nothing to judge, so no judge was called. */
  judgeSkipped?: true;
  staticDedupCount?: number;
  llmDedupCount?: number;
  /** Tool results the judge graded as findings, on top of the review's. */
  toolAlertCount?: number;
  /** Leads of the last round the judge graded again, on top of the review's findings. */
  carriedLeadCount?: number;
  /** Leads listed as not finished checking before the judge saw them. */
  openLeadCount?: number;
  /** Leads the judge kept that its checks left unsettled, listed as not finished checking. */
  unsettledLeadCount?: number;
  /** Findings of the sweeps left out, since the round judged the same problem already. */
  sweepRepeatCount?: number;
  /** Findings of the sweeps dropped as repeats of earlier resolved findings, a part of `staticDedupCount` and `llmDedupCount`. */
  sweepDedupCount?: number;
  /** Findings no judge call graded, such as the verdict reader's blockers, posted or in the round record only. */
  addedAfterJudgeCount?: number;
  /** Findings the judge kept that a later step left out as a repeat of another finding, such as a verdict reader's blocker. */
  repeatCount?: number;
  /** The findings left in the round record only, by reason. */
  recordOnly?: Partial<Record<RecordOnlyReason, number>>;
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
  /** The grades of the posted findings. Set once the round finished. */
  postedSeverities?: Record<string, number>;
  /** The grades the finders gave the findings the judge dropped. */
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
  /** Set when the token service's catch-up started the run, which the first line says. */
  catchUp?: true;
  /** When the planner started, in ms since the epoch. The times below are too. */
  plannerStartedAt?: number;
  sideChecks?: Partial<Record<SideCheckKind, SideCheckState>>;
  /** When the finders ended, which starts the judge's time. */
  judgeStartedAt?: number;
  /** What the judge decided, over every judge call once the round finished. */
  graded?: GradedCounts & { durationMs: number };
  refuter?: { total: number; outcomes: Partial<Record<RefutationOutcome, number>> };
  verdictReader?: { startedAt: number; durationMs?: number };
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
  importance?: Importance;
}

export interface ReviewMetadata {
  config: {
    /** Model of the first reader of the review group. Unset when no group read the PR. */
    reviewerModel?: string;
    judgeModel: string;
    /** Triage answers and where they came from, as one readable line. */
    triage: string;
    teamAgents: string[];
    /** The lines of `limitFallbackLines`: each model that reached a limit or could not be reached, and the model that answered in its place. */
    limitFallbacks?: string[];
    memoryEnabled: boolean;
    memoryRepo: string;
  };
  judgeDecisions: JudgeDecision[];
  /** The newest usage reading of each subscription window the round's calls used. */
  limits?: LimitUsage[];
  timing: {
    parseMs: number;
    reviewMs: number;
    /** Unset on a round that called no judge. */
    judgeMs?: number;
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
  /** The units of the change the finders answered for. Each finder's lines are in `reviewers.agentMetrics`. */
  units?: RoundUnits;
  /** Each dependency's source the reviewer tools read or tried to read, with its version and where that came from. */
  dependencySources?: RoundDependencySource[];
  /** The open PRs and issues that may relate to this PR, with their classification. */
  relatedWork?: RoundRelatedWork;
  /** Each sibling comparison the round found, asked or cut. */
  comparisons?: RoundComparison[];
  /** Each sweep the round's findings started, asked or cut. */
  sweeps?: RoundSweep[];
  /** The reads of the change after the finders. Unset on a round that runs none. */
  secondReads?: RoundSecondReads;
  /** The statements of the PR text the change relies on, each with how its check ended. */
  prClaims?: RoundPrClaims;
  /** The fixes the change holds, each with how its check ended. */
  fixes?: RoundFixes;
  /** Whether the PR is useful and covers one topic, by the scope reader. */
  scope?: RoundScope;
  /** How each open lead ended, so the next round carries over the ones still unsettled. */
  leads?: RoundLead[];
  /** The retries, moves to a fallback model and judge calls the round did not start, and why. */
  notStarted?: RoundNotStarted[];
  /**
   * Set on a round that approved: whether the approval was held, and why: a conflict with the base, a draft, a config
   * that failed to load, files the review could not read, open warning threads, or GitHub refusing the approval. `held`
   * names only the first hold, so `warningsHeld` says whether warnings held it too.
   */
  approval?: { held: false | 'conflict' | 'draft' | 'config' | 'unread' | 'warnings' | 'refused'; warningsHeld?: true };
  /**
   * What the change does and how to test it, from the verdict reader. Set when warnings held the round's approval and
   * no person must approve it. The held review leaves both out, and the approval posted once the warnings clear shows them.
   */
  readyReport?: Pick<VerdictReport, 'whatThisDoes' | 'whatToTest'>;
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
  /** The files the analyzer left out, each with why. */
  skippedFiles?: SkippedFile[];
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface RoundSignalSourceRun {
  source: Exclude<StaticSignalSource, AnalyzerName | 'hidden_characters' | 'lockfile'>;
  status: 'ran' | 'skipped';
  /** Results on lines in the diff. */
  results?: number;
  /** Why the source gave nothing, such as an HTTP 403. */
  reason?: string;
}

/**
 * Where the `review` block came from: the base branch, or the built-ins because the base has none, could not be read, or
 * failed validation. `default_branch` says that the base has no config file, so the default branch's file gave every
 * setting, and `default_branch_unreadable` or `default_branch_invalid` that this file could not be read or failed validation.
 */
export type ConfigSource = 'base' | 'builtin' | 'default_branch' | 'base_unreadable' | 'base_invalid' | 'default_branch_unreadable' | 'default_branch_invalid';

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
   * On an incomplete round that limits stopped, the latest time, in ISO 8601, at which one of them lifts, when the
   * providers named one. The token service starts no retry of the commit before it.
   */
  retryAfter?: string;
  /** Set when the round kept results of an earlier attempt on the same commit that ended incomplete. */
  reusedFrom?: RoundReusedFrom;
  /** How many posted findings the fix-rate history would lower (`FindingCalibration.wouldLower`). Unset without a history. */
  calibrationLowered?: number;
  /**
   * Set when the record was too large for the review even compressed: the fields that were left out, such as
   * `judge.dropped`, in the order they were cut.
   */
  omitted?: string[];
  /**
   * Set when such a record kept `reviewers.rawFindings` with only titles, locations, severities and reviewers, and
   * `usesOutsideDiff` with `types` cut to their locations: the fields it shortened.
   */
  compacted?: string[];
}

/** The attempt whose results a round kept: the review that holds its round record, and when that attempt ended. */
export interface RoundReusedFrom {
  review: number;
  timestamp: string;
}

/** The round record of the PR's newest round, which ended incomplete, and the review that holds it. */
export interface EarlierAttempt {
  record: RoundContext;
  review: number;
  /** The review's GraphQL node id, which tells whether anyone edited it. */
  nodeId?: string;
}

/**
 * What an earlier round's finder stage gave, which a replay keeps in place of running it: the planner's answer, the
 * finders it picked, and the findings of every call before the dedup, with their reviewer names.
 */
export interface FinderReplay {
  /** `null` when the planner failed and the round took its fail-safe answers. */
  planner: PlannerResult | null;
  finders: string[];
  findings: RoundRawFinding[];
  /** The fix checks' records, which keep an earlier thread open on a workaround. */
  fixes?: RoundFix[];
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
  /** A Deeper review: a group with fewer than two finders moves up to `full`, and every finder runs at xhigh effort or one level above a configured effort. */
  deeper?: boolean;
  /** The token service starts one more review of the commit if this round ends incomplete. */
  automaticRetry?: boolean;
}

/** A one-off mode a settings box queued for a run. */
export type RunMode = 'again' | 'deeper' | 'draft';

/** What the PR coordinator says about a PR. */
export interface PrState {
  /** The PR's sticky settings. `auto` says whether every push to the draft is reviewed, and is left out where that box does nothing. */
  settings: { paused: boolean; auto?: boolean };
  /** The commit of the PR's last finished review. */
  lastReviewed?: string;
  /** The modes of this run. */
  runModes: ReadonlySet<RunMode>;
  /** The modes of the work still queued for the PR. */
  queuedModes: ReadonlySet<RunMode>;
  /** The ids of the review comments whose own run is still queued for the PR. Empty when the token service names none. */
  queuedReplies: ReadonlySet<number>;
}

/** What a run tells the PR coordinator once it has posted, as `/state/report` takes it. */
export interface StateReport {
  reviewed?: { commit: string };
  /** The approval of a commit and whether it is held, or `null` once Manki withdrew it. */
  approval?: { commit: string; held: boolean } | null;
  /** Why automatic review is paused, or `null` once it is not. */
  pause?: { reason: string } | null;
}

/** Model spec each pipeline stage runs on. */
export interface ReviewModels {
  planner: string;
  judge: string;
  /** Model of the second refuter, when `models.second_refuter` is set. */
  refuterPair?: string;
  dedup: string;
}

/** Provenance of the event that triggered a round. */
export interface RoundTrigger {
  /**
   * `github.context.eventName` plus the action and (when applicable) the
   * marker comment that fired. Examples: `pull_request:synchronize`,
   * `issue_comment:created:/manki review`,
   * `issue_comment:edited:settings:again`,
   * `pull_request_review:edited:box:again`.
   */
  event: string;
  /** `github.context.payload.sender.login`, or `'unknown'` when absent. */
  sender: string;
  /** Set when the token service's catch-up started the round, since no review of the commit had finished. */
  catchUp?: true;
}

/** Per stage, the distinct `LLMCall.promptDigest`s of its calls in the round, sorted. Finders can differ by focus. */
export type PromptVersions = Record<string, string[]>;

/** Effective config snapshot for the round: AI pipeline behavior fields (model behavior, memory). Convergence/post-processing rules are not included. */
export interface RoundConfig {
  /** Written by releases that sized the team by `review_level`. */
  reviewLevel?: ReviewLevel;
  memoryEnabled: boolean;
}

export interface RoundDiffExcludedFile {
  path: string;
  matchedPattern: string;
  /** Set when the pattern is one of `closed_paths`, not of `exclude_paths`. */
  closed?: true;
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
  /** Files filtered out by `config.exclude_paths` or `config.closed_paths` and which pattern fired. */
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
  /** Model of the first reader of the round's review group. The sibling comparisons, related repo checks, claim checks, pattern checks, fix checks and sweeps ran on it too. */
  reviewer?: string;
  judge: string;
  /** Model of the second refuter, on rounds where it checked a finding or an earlier round's answer of it was reused. */
  refuterPair?: string;
  dedup?: string;
  /** Stages that moved to a fallback model, after a safety filter refused them or their model reached a limit, in the order they moved. */
  fallbacks?: RoundModelFallback[];
}

/** A stage call that a safety filter refused and that ran again on `fallbackModel`, or one whose model reached a limit and that `fallbackModel` answered. */
export interface RoundModelFallback {
  stage: keyof NonNullable<RoundUsage['perStage']>;
  /** Finder that moved, on the `reviewer` stage. */
  agent?: string;
  fallbackModel: string;
  /** The provider's refusal signal, such as `refusal (cyber)` or `content_filter`. With `limit`, the limit reached, such as `OpenAI endpoint limit reached`. */
  reason: string;
  /** Set when the stage's model reached a limit. Unset after a safety refusal. */
  limit?: true;
  /** Set, with `limit`, when no request of the call reached the stage's model because its endpoint could not be reached. */
  unreachable?: true;
}

/** A retry of a finder, a move to a fallback model, or a model call after the finders that the round did not start, and why. */
export interface RoundNotStarted {
  /**
   * `retry` for a finder's retry, `fallback` for a stage's move to its fallback model, `call` for a model call after the
   * finders, such as a call of the dedup, the judge, a refuter, a sweep or the verdict reader. `stage` and `agent` name it.
   */
  kind: 'retry' | 'fallback' | 'call';
  stage: RoundModelFallback['stage'];
  /** Finder or check whose retry, move or call was not started. */
  agent?: string;
  reason: string;
}

/**
 * Provenance of the triage that produced this round's team.
 *
 * - `planner`: the planner LLM answered. Any answer it left out took the side that adds review.
 * - `heuristic_fallback`: the planner was attempted but failed (timeout,
 *   truncation, parse error), so every answer took the side that adds review.
 * - `heuristic`: written by releases that skipped the planner for a pinned `review_level`.
 * - `disabled`: no planner was called, as in the record of an earlier round that `reviewLocal` builds, or in a
 *   round of a release that could turn the planner off. Every answer took the side that adds review.
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
  /** Triage the team was built from, after the floor and file rules. */
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
  preExisting?: string;
  rule?: Finding['rule'];
}

/** A finding the judge dropped, with the judge's reasoning. */
export interface RoundJudgeDrop {
  title: string;
  file: string;
  line: number;
  reviewers: string[];
  reviewerSeverity?: FindingSeverity;
  lowestReviewerSeverity?: FindingSeverity;
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
  /** Mirrors `Finding.cell`. A dropped finding has one only when a later stage dropped it, or the judge dropped it with a `drop` premise. */
  cell?: GradeCell;
  /** Mirrors `Finding.rule`. */
  rule?: Finding['rule'];
}

/** A unit of the change, as the round record keeps it. */
export interface RoundUnit {
  id: string;
  /** A function the change touches, or a condition it adds, changes or removes. */
  kind: 'function' | 'condition';
  /** `file:line` or `file:start-end` in the head commit, or with `deleted` in the base. */
  at: string;
  /** The function's name. */
  name?: string;
  /** Set on a condition of a file the PR deletes. */
  deleted?: true;
  /** Set when the cap per finder call left it off every finder's list. */
  cut?: true;
}

/** The units of the change the finders answered for. */
export interface RoundUnits {
  listed: RoundUnit[];
  /** How many units past the round's limit were not listed. */
  overLimit?: number;
}

/** A finder's line for one unit of the change. */
export interface RoundUnitLine {
  unit: string;
  /** What the finder says it checked there. Unset when it gave the unit no line. */
  checked?: string;
  /** The defect it named there. Unset when it named none. */
  defect?: string;
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
  /** Set when the finder was asked once more, since its first answer opened none of the files outside the diff that the lists in its message name, or left a unit of the change without a line. */
  askedAgain?: true;
  /** The finder's line for each unit of the change it was asked to answer for. A unit without `checked` was not covered, even after a second ask. */
  units?: RoundUnitLine[];
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
  /** A digest of everything the finder was sent, set once its read finished. A retry keeps the findings of a finder whose input digest is the same. */
  inputDigest?: string;
  /** The findings the finder gave, counted when its read finished, apart from `findingsRaw`. A retry keeps nothing when they differ. */
  findingsReturned?: number;
  /** Set when the round kept the finder's findings from `meta.reusedFrom` and did not run it. */
  reused?: true;
}

export interface RoundJudge {
  /** Narrative summary written by the judge. */
  summary: string;
  /** Why no judge was called: the round had no finding, open thread or carried warning for it. */
  skipped?: 'nothing_to_judge';
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
  /**
   * Count of findings dropped because they object to code that applies a prior-round
   * `suggestedFix` (tagged `OWN_PROPOSAL_TAG`).
   */
  ownProposalDemotedCount?: number;
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
 * emit time. When live thread state shifts it to `agree` or back to `none`,
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
  /** `resolve`: resolved in the GitHub UI. `dismiss`: through `/manki dismiss` in the thread. */
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
   * The findings Manki recorded without posting them: pre-existing ones, and those with an `unpostedReason`. Nothing that
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

/** The fix rate of a finding's class, from the repo's `metrics/fix-rate.jsonl`. */
export interface FindingCalibration {
  /** Severity and finder model, plus the category when that finer class has enough posted findings. */
  class: string;
  posted: number;
  fixed: number;
  rate: number;
  /** Whether the class has enough posted findings and a fix rate low enough that the finding would be lowered. */
  wouldLower: boolean;
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
  /** Mirrors `Finding.lowestReviewerSeverity`. */
  lowestReviewerSeverity?: FindingSeverity;
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
  /** Mirrors `Finding.revertGap`. */
  revertGap?: string;
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
  /** Mirrors `Finding.originCheck`. */
  originCheck?: OriginCheck;
  /** Mirrors `Finding.otherFinderVote`. */
  otherFinderVote?: OtherFinderVote;
  /** Mirrors `Finding.importance`. */
  importance?: Importance;
  /** Mirrors `Finding.gradeIfConfirmed`. */
  gradeIfConfirmed?: FindingSeverity;
  /** Mirrors `Finding.judgeIfConfirmed`. */
  judgeIfConfirmed?: 'blocker' | 'warning';
  /** Mirrors `Finding.doubts`. */
  doubts?: Doubt[];
  /** Mirrors `Finding.trigger`. */
  trigger?: string;
  /** How often posted findings of the finding's class were fixed in the repo's fix-rate history. Recorded only, never acted on. */
  calibration?: FindingCalibration;
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
  /** The description of a blocker recorded as `body`, which a later round posts as a thread, or of a warning with `citedLine`, which a later judge is shown. */
  description?: string;
  /**
   * Set on a warning the round listed only in its review body, so a later round can tell whether the place still reads
   * the same. A warning without a line, or on a line the round could not read, has none.
   */
  citedLine?: CitedLine;
  /** Set on a body warning whose file the round could not read, so it has no `citedLine`. A later round carries it without comparing its line. */
  unread?: true;
  /** Set on a warning that holds the approval: through its thread, or as `body` with no thread. */
  holds?: true;
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
 * Why a warning carried from an earlier review body is no longer listed: its file is gone (`file_gone`), or a finding
 * the judge graded this round names it. That finding is listed (`restated`), a note the
 * review leaves out (`hidden_note`), dropped by the judge (`judge_dropped`) or left out by a later step (`left_out`).
 * A warning left out because nothing proves it ends none. A warning the judge evaluated as addressed ends as `fixed`.
 */
export type CarriedEndReason = 'file_gone' | 'restated' | 'hidden_note' | 'judge_dropped' | 'left_out' | 'fixed';

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
  /** The id of the developer's comment a thread reply answers, so a later reply in the thread never counts as answered by it. */
  answers?: number;
  /** The statements of the developer's reply that a thread reply checked, in the order it lists them. */
  statements?: ReplyStatementRecord[];
  /** How many statements a thread reply left unchecked because the developer's reply held more than it checks. */
  uncheckedStatements?: number;
  /** How many statements a thread reply did not list because their quote is not in the developer's reply, or repeats one. */
  droppedStatements?: number;
  /** The model's own answer to a thread reply, before the checks. Unset when the answer could not be read. Nothing decides on it. */
  modelAnswer?: ReplyModelAnswer;
}

/** What the model answered to a thread reply. `cited` is model text, which can quote the developer or the PR. */
export interface ReplyModelAnswer {
  outcome: 'Fixed' | 'FixedElsewhere' | 'Withdrawn' | 'Agreed' | 'Kept' | 'Unverified';
  /** The lines of the PR in the answer's proof that exist. */
  proof: string[];
  /** The proof entries as the model gave them, bounded and redacted. */
  cited: string[];
}

/** Why a thread reply could not check a statement. The first two are the model's answer, the rest come from Manki's own checks. */
export type UncheckedReason =
  | 'outside_code' | 'not_reachable'
  | 'no_line' | 'search_term' | 'not_related' | 'not_fetched' | 'no_checkout' | 'search_failed' | 'search_found' | 'search_cut'
  | 'description_unread' | 'description_text' | 'description_found';

/** How one statement of a developer's reply fared. It holds no words of the developer, no search term and no text of the PR description. */
export interface ReplyStatementRecord {
  status: 'confirmed' | 'contradicted' | 'not_checkable';
  /** The lines the status rests on, each checked to exist: `path:line` of the PR, or `owner/name:path:line`. */
  places?: string[];
  /** Where Manki's own search found no line: `owner/name`, or `pr` for the PR's repository. */
  searched?: string;
  /** Set when the status rests on the PR description: `held` when it holds the cited text, `absent` when Manki's search of it found nothing. */
  description?: 'held' | 'absent';
  why?: UncheckedReason;
}

/**
 * What a thread reply decided: the word it opens with, and what happens to the thread. `stays_open` is a blocking or
 * security thread only a maintainer may close, `stays_resolved` such a thread that stays resolved and keeps blocking,
 * `resolve_failed` a thread Manki could not resolve, `lookup_failed` a thread GitHub could not list,
 * `deferred_to_round` a fix a later round did not find, `confirmed_by_round` a fix the reply could not prove and a later
 * round found, and `pr_closed` a thread left as it is on a merged or closed PR.
 */
export interface ReplyDecision {
  outcome: 'Fixed' | 'Agreed' | 'Withdrawn';
  thread: 'resolves' | 'stays_open' | 'stays_resolved' | 'resolve_failed' | 'no_permission' | 'already_resolved' | 'not_found' | 'lookup_failed' | 'deferred_to_round' | 'confirmed_by_round' | 'pr_closed';
}

/** The round's LLM usage: totals over its calls, per stage and per model, and the calls themselves. */
export interface RoundUsage extends RoundUsageStage {
  /** Wall-clock time of the review run, from its start to the review it posts. `durationMs` is the time spent in model calls. */
  wallClockMs?: number;
  perStage?: Partial<Record<'planner' | 'reviewer' | 'compare' | 'claims' | 'claim_terms' | 'claim_check' | 'fixes' | 'fix_check' | 'related_check' | 'pattern_check' | 'sweep' | 'judge' | 'vote' | 'rating' | 'dedup' | 'verdict' | 'scope' | 'related' | 'translate', RoundUsageStage>>;
  perModel?: Record<string, RoundUsageStage>;
  llmCalls?: LLMCall[];
  /** The newest reading of each subscription usage window the round's calls reported. */
  limits?: LimitUsage[];
  /** Tool calls Manki's tool server refused because they named a path `closed_paths` closes. Unset when none was. */
  closedCalls?: number;
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
  model?: string;
  reviewerModel?: string;
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
