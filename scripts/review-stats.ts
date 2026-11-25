/**
 * Prints review statistics for the last merged pull requests of a repository, read from Manki's round records and its
 * thread replies, so a change to the review can be compared before and after. It only reads from GitHub.
 *
 * Usage:
 *   npm run review-stats -- --repo <owner/repo> [--last <n>] [--fix-rate <fix-rate.jsonl>]
 *
 * `--fix-rate` takes the repository's `metrics/fix-rate.jsonl` from its memory repo, for the fix rate per severity and per check status.
 * Reads the GitHub token from `GITHUB_TOKEN`, or from `gh auth token` when that is unset.
 */

import * as github from '@actions/github';
import { readFileSync } from 'fs';

import { findPriorThreadId } from '../src/finding-fingerprint';
import { replyOutcome } from '../src/interaction';
import { compareVersions } from '../src/lockfile';
import { summarizeCalls } from '../src/providers';
import type { LLMCall } from '../src/providers';
import { findingPlace, ledOutcome, threadMarkerSlug, threadSeverity } from '../src/recap';
import { readFileParts } from '../src/review';
import { extractApprovalRecords } from '../src/review-record';
import { isSecondReadName, isSweepName, outcomeOf, PRE_EXISTING_TAG, SEVERITY_ORDER } from '../src/types';
import type { ApprovalRecord, FindingFingerprintEntry, Refutation, ReplyRecord, RoundContext, RoundSweep, TokenServiceCall } from '../src/types';
import { aggregate, renderTable } from './fix-rate-report';
import { githubToken, historyLines } from './review-history';

const DEFAULT_LAST = 40;
const MANY_ROUNDS = 5;
// A finding graded `ignore` is dropped, so no round posts one.
const SEVERITIES: readonly string[] = SEVERITY_ORDER.filter(s => s !== 'ignore');
const LIMIT_MARKS = [70, 80, 90] as const;

type Posted = Parameters<typeof historyLines>[2]['reviews'][number];

interface ThreadComment extends Posted {
  in_reply_to_id?: number | null;
  pull_request_review_id?: number | null;
  path?: string;
  line?: number | null;
  original_line?: number | null;
}

type PostedThread = Parameters<typeof findPriorThreadId>[1][number];

/** One merged pull request: the records of its completed rounds in posting order, and the comments of its review threads. */
export interface PrRecords {
  number: number;
  rounds: RoundContext[];
  /** The id of the review that holds each of `rounds`. */
  reviewIds: number[];
  /** The records of its incomplete rounds, which no later round read as an earlier round. */
  incompleteRounds: RoundContext[];
  /** The round records in its reviews that could not be decoded or parsed. */
  undecodedRounds: number;
  /** The records of Manki's thread replies. */
  replies: ReplyRecord[];
  /** The decisions of the review state checks, from their approval reviews and the notices still standing. */
  approvals: ApprovalRecord[];
  threadComments: ThreadComment[];
}

interface FinderStats {
  rounds: number;
  rawFindings: number;
  /** Kept findings this finder raised alone, and those it raised with another finder. */
  keptOnly: number;
  keptShared: number;
  toolSteps: number[];
  /** Calls with a step budget, and those told to wrap up. */
  budgetedCalls: number;
  wrapUps: number;
  /** Per finder and round whose record lists the finder's tool steps, the steps and the distinct files its calls with steps took and read. */
  stepsPerRound: number[];
  filesPerRound: number[];
  /** Of those files, the ones in a related repo. */
  relatedFiles: number;
  /** Of the files of the PR's own repo read in rounds whose record lists the changed files, those the round's diff changes. */
  filesInDiff: number;
  filesInListedRounds: number;
  /** The steps by tool: the CLI's built-in `Read`, Manki's `read_file`, and every other tool. */
  readSteps: number;
  readFileSteps: number;
  otherSteps: number;
  /** The characters of text each `Read` and each `read_file` step gave the model, over the steps that record it. */
  readChars: number[];
  readFileChars: number[];
}

/**
 * The findings the rounds posted at one severity. A finding the round put under an earlier thread, or one that matches a
 * thread an earlier review opened, counts in none of the fields.
 */
interface SeverityStats {
  posted: number;
  /** Findings posted by a round that ended `READY`. */
  inApprovedRounds: number;
  /** Findings first raised by a round after the first. `onReviewedCode` counts those of them on code an earlier round reviewed. */
  raisedLater: number;
  onReviewedCode: number;
}

const noFindings = (): SeverityStats => ({ posted: 0, inApprovedRounds: 0, raisedLater: 0, onReviewedCode: 0 });

const FIRST_ROUND_GRADES = ['blocker', 'warning'] as const;

type FirstRoundGrade = (typeof FIRST_ROUND_GRADES)[number];

// Before this release a round without the earlier round's change tagged every finding `new` and did not say so.
const ORIGINS_PROVEN_FROM = '7.5.0';

/** The condition `originsProven` checks, as the report and the docs name it. */
const ORIGINS_PROVEN_TEXT = `ran on Manki ${ORIGINS_PROVEN_FROM} or later, read the change the round before reviewed, and read the diff since that round`;

/** The blockers and warnings one PR posted: those round 1 found, and those a later round first raised on code an earlier round reviewed. */
interface FirstRoundPr {
  number: number;
  grades: Record<FirstRoundGrade, { firstRound: number; later: number }>;
  /** Whether the PR's first record in posting order is of a round other than 1. Such a PR counts in no share. */
  noFirstRound: boolean;
  /** The PR's round records that cannot say where a finding was first raised. A PR with any counts in no share. */
  unproven: number;
}

const SWEEP_STATUSES: readonly RoundSweep['status'][] = ['answered', 'too_specific', 'failed', 'cut'];

/** What the sweeps of the rounds did. A round with `review.sweep` off has none. */
interface SweepStats {
  /** Rounds that started at least one sweep. */
  rounds: number;
  statuses: Record<RoundSweep['status'], number>;
  /** Sweeps that reported another place, and the places they reported, before dedup and the judge. */
  withPlaces: number;
  places: number;
  /** The findings of a sweep the rounds posted, per severity, counted as `SeverityStats.posted` counts. */
  posted: Map<string, number>;
  /** The findings of a sweep the rounds recorded without posting, and those the judge dropped. */
  unposted: number;
  dropped: number;
  /** The sweep calls, and the dedup, judge and refuter calls on what they reported. */
  calls: LLMCall[];
}

/** The decision tallies the report lists, each as a table of how often each value occurred. */
const DECISIONS = [
  'Prompt versions (rounds per stage and digest)',
  'Pause causes',
  'Static analysis sources',
  'Grade changes',
  'Pre-existing claims (how each was checked)',
  'Rule findings (the judge\'s answer and the grade)',
  'Memory suppressions (findings hidden per suppression)',
  'Findings recorded without posting (per reason and severity)',
  'Warnings carried from an earlier review body (listed again per rounds since first listed, ended per reason)',
  'Verdict reader per slice',
  'Second reads (per round: reads run, blockers and warnings added, why they stopped)',
  'Approvals',
  'State check approvals',
  'Thread reply decisions',
  'Token service calls',
] as const;

type Decision = (typeof DECISIONS)[number];

export interface ReviewStats {
  /** PRs with the record of at least one completed round. Only they count in the statistics. */
  prs: number;
  /** Merged PRs without such a record, such as one Manki never reviewed. */
  unreviewed: number;
  roundsPerPr: number[];
  /**
   * PRs whose round records all decoded and are rounds 1, 2, 3 in posting order. Only they count in the figures that
   * read a round number: `passedFirstRound`, `raisedLater`, the follow-up rounds and the rounds a carried warning waited.
   */
  numberedPrs: number;
  passedFirstRound: number;
  manyRounds: number;
  rounds: number;
  /** Rounds that ended incomplete. They count in no other figure. */
  incompleteRounds: number;
  /** Rounds that ended `READY`. */
  approvedRounds: number;
  /** Per PR with rounds after its first approved round, the number of those rounds. */
  roundsAfterApproval: number[];
  severities: Record<string, SeverityStats>;
  /** Per reviewed PR, the blockers and warnings round 1 found against those a later round found on reviewed code. */
  firstRound: FirstRoundPr[];
  /** The tables `aggregate` builds from the fix-rate lines of these PRs. */
  fixRate: ReturnType<typeof aggregate>;
  blockerOutcomes: { fixed: number; withdrawn: number; other: number };
  finders: Map<string, FinderStats>;
  readerRounds: number;
  readerBlockers: number;
  refutations: Map<string, number>;
  /**
   * Per finding the second refuter answered, the first refuter's outcome and its own, such as `confirmed / disproved`.
   * An answer a later round reused counts once, as in `refutations`.
   */
  pairRefutations: Map<string, number>;
  /** The second refuter's calls. */
  pairRefutationCalls: LLMCall[];
  sweeps: SweepStats;
  costPerPr: number[];
  costPerRound: number[];
  followUpRounds: number;
  interRoundDiffCutOrUnknown: number;
  /** How often each value of each decision occurred. */
  decisions: Map<Decision, Map<string, number>>;
  /** Per round that loaded memory, the learnings and the suppressions it loaded. */
  learningsLoaded: number[];
  suppressionsLoaded: number[];
  /** Per round read in slices, the slice count. */
  slicesPerRound: number[];
  /** Per follow-up round, the changed files the push since the last round touched. */
  changedSinceLastRound: number[];
  /** Per round, the threads with a fix claim. */
  fixClaims: number[];
  /** Per configured related repo, the rounds that listed it, the reads of each round that read it, and its failures. */
  relatedRepos: Map<string, RelatedRepoStats>;
  /** Per week, account and window, the highest used share any round read, and the rounds at or past each of `LIMIT_MARKS`. */
  limits: Map<string, LimitStats>;
}

interface RelatedRepoStats {
  rounds: number;
  reads: number[];
  failed: number;
  skipped: number;
}

interface LimitStats {
  week: string;
  account: string;
  window: string;
  highest: number;
  roundsPast: number[];
}

function increment(counts: Map<string, number>, key: string, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

function tally(stats: ReviewStats, decision: Decision, value: string, by = 1): void {
  const counts = stats.decisions.get(decision) ?? new Map<string, number>();
  increment(counts, value, by);
  stats.decisions.set(decision, counts);
}

/** Returns the round records and thread comments of `number` from what GitHub lists for it. */
export function prRecords(
  repo: string, number: number, posted: { reviews: Posted[]; threadComments: ThreadComment[]; issueComments?: Posted[] },
): PrRecords {
  let undecodedRounds = 0;
  const lines = historyLines(repo, number, { reviews: posted.reviews, comments: posted.threadComments }, (kind) => {
    if (kind === 'round') undecodedRounds++;
  });
  // The state check's approval decisions ride on its approval reviews and on its notices while they stand.
  const approvals = [...posted.reviews, ...(posted.issueComments ?? [])]
    .filter(item => item.user?.type === 'Bot' && item.body)
    .flatMap(item => extractApprovalRecords(item.body!).flatMap(text => {
      try {
        return [JSON.parse(text) as ApprovalRecord];
      } catch {
        return [];
      }
    }));
  const rounds = lines.filter(line => line.kind === 'round').map(line => ({ record: line.record as RoundContext, reviewId: line.sourceId }));
  const completed = rounds.filter(round => !round.record.meta?.incomplete);
  return {
    number,
    rounds: completed.map(round => round.record),
    reviewIds: completed.map(round => round.reviewId),
    incompleteRounds: rounds.filter(round => round.record.meta?.incomplete).map(round => round.record),
    undecodedRounds,
    replies: lines.filter(line => line.kind === 'reply').map(line => line.record as ReplyRecord),
    approvals,
    threadComments: posted.threadComments,
  };
}

/**
 * Sorts each blocker thread Manki started by the last settling reply Manki wrote in it: `Fixed` (a person's fix or a
 * round that confirmed one), `Withdrawn`, or anything else, such as no such reply or `Agreed`.
 */
function blockerOutcomes(comments: ThreadComment[]): ReviewStats['blockerOutcomes'] {
  const outcomes = { fixed: 0, withdrawn: 0, other: 0 };
  const byBot = comments.filter(c => c.user?.type === 'Bot' && c.body);
  for (const root of byBot.filter(c => !c.in_reply_to_id && threadSeverity(c.body!) === 'blocker')) {
    // An answer that opens with its state settles as the outcome its marker stands for, which an "Unverified" does not.
    const last = byBot.filter(c => c.in_reply_to_id === root.id).map(c => replyOutcome(ledOutcome(c.body!) ?? c.body!.trim())).filter(o => o !== undefined).at(-1);
    if (last === 'Fixed') outcomes.fixed++;
    else if (last === 'Withdrawn') outcomes.withdrawn++;
    else outcomes.other++;
  }
  return outcomes;
}

/** Returns the threads Manki opened, each with the id of the review that posted it. */
function mankiThreads(comments: ThreadComment[]): (PostedThread & { reviewId: number })[] {
  return comments.flatMap(c => {
    const markerSlug = c.user?.type === 'Bot' && !c.in_reply_to_id && c.body ? threadMarkerSlug(c.body) : undefined;
    if (!markerSlug || !c.path || !c.pull_request_review_id) return [];
    return [{ threadId: String(c.id), ...findingPlace(c.body ?? '', c.path, c.line, c.original_line), markerSlug, reviewId: c.pull_request_review_id }];
  });
}

function finder(stats: ReviewStats, model: string): FinderStats {
  const found = stats.finders.get(model) ?? {
    rounds: 0, rawFindings: 0, keptOnly: 0, keptShared: 0, toolSteps: [], budgetedCalls: 0, wrapUps: 0,
    stepsPerRound: [], filesPerRound: [], relatedFiles: 0, filesInDiff: 0, filesInListedRounds: 0, readSteps: 0, readFileSteps: 0, otherSteps: 0,
    readChars: [], readFileChars: [],
  };
  stats.finders.set(model, found);
  return found;
}

/**
 * Adds up the statistics over `prs`. A finder is keyed by the model it ran on, or by its name in records without one.
 * `fixRateLines` are lines of the memory repo's `metrics/fix-rate.jsonl`, of which only those of `prs` count.
 */
export function computeStats(prs: PrRecords[], fixRateLines: string[] = []): ReviewStats {
  const stats: ReviewStats = {
    prs: 0, unreviewed: 0, roundsPerPr: [], numberedPrs: 0, passedFirstRound: 0, manyRounds: 0, rounds: 0, incompleteRounds: 0, approvedRounds: 0, roundsAfterApproval: [], severities: {}, firstRound: [],
    fixRate: aggregate(fixRateLines, new Set(prs.map(pr => pr.number))),
    blockerOutcomes: { fixed: 0, withdrawn: 0, other: 0 }, finders: new Map(), readerRounds: 0, readerBlockers: 0,
    refutations: new Map(), pairRefutations: new Map(), pairRefutationCalls: [],
    sweeps: { rounds: 0, statuses: { answered: 0, too_specific: 0, failed: 0, cut: 0 }, withPlaces: 0, places: 0, posted: new Map(), unposted: 0, dropped: 0, calls: [] },
    costPerPr: [], costPerRound: [], followUpRounds: 0, interRoundDiffCutOrUnknown: 0,
    decisions: new Map(), learningsLoaded: [], suppressionsLoaded: [], slicesPerRound: [], changedSinceLastRound: [], fixClaims: [],
    relatedRepos: new Map(), limits: new Map(),
  };
  for (const pr of prs) {
    stats.incompleteRounds += pr.incompleteRounds.length;
    if (pr.rounds.length === 0) {
      stats.unreviewed++;
      continue;
    }
    stats.prs++;
    stats.roundsPerPr.push(pr.rounds.length);
    const numbered = roundNumbering(pr) === undefined;
    if (numbered) stats.numberedPrs++;
    if (numbered && pr.rounds[0].meta.outcome === 'READY') stats.passedFirstRound++;
    if (pr.rounds.length >= MANY_ROUNDS) stats.manyRounds++;
    const firstApproval = pr.rounds.findIndex(round => round.meta.outcome === 'READY');
    if (firstApproval >= 0 && firstApproval < pr.rounds.length - 1) stats.roundsAfterApproval.push(pr.rounds.length - 1 - firstApproval);
    let prCost = 0;
    const answers = new Set<string>();
    const threads = mankiThreads(pr.threadComments);
    // A record that did not decode may hold any round.
    const found: FirstRoundPr = { number: pr.number, grades: { blocker: { firstRound: 0, later: 0 }, warning: { firstRound: 0, later: 0 } }, noFirstRound: false, unproven: pr.undecodedRounds };
    stats.firstRound.push(found);
    for (const [index, round] of pr.rounds.entries()) {
      stats.rounds++;
      const cost = round.usage?.estimatedCostUsd ?? 0;
      prCost += cost;
      stats.costPerRound.push(cost);
      const approved = round.meta.outcome === 'READY';
      if (approved) stats.approvedRounds++;
      // A review's id grows with the order the reviews were posted in.
      const earlierThreads = threads.filter(thread => thread.reviewId < pr.reviewIds[index]);
      const posted = (round.findings?.entries ?? []).filter((entry) => {
        // A record without `posted` is read by the rules the review posts by. An entry's `threadId` names the earlier thread
        // the finding restates or adds to, and a finding that matches a thread an earlier review opened gets no thread either.
        const carried = entry.posted ? entry.posted === 'earlier_thread' : !!entry.threadId || findPriorThreadId(entry.fingerprint, earlierThreads) !== undefined;
        // An earlier blocker listed again to get a thread is no finding of this round.
        return !carried && !entry.relisted;
      });
      tallyFirstRound(found, round, index > 0 ? pr.rounds[index - 1] : undefined, posted);
      for (const entry of posted) {
        const severity = stats.severities[entry.severity] ??= noFindings();
        severity.posted++;
        if (fromSweep(entry)) increment(stats.sweeps.posted, entry.severity);
        if (approved) severity.inApprovedRounds++;
        // A finding with the origin `earlier` restates one an earlier round listed.
        if (numbered && round.meta.round > 1 && originsProven(round) && entry.origin && entry.origin !== 'earlier') {
          severity.raisedLater++;
          if (entry.origin === 'reviewed') severity.onReviewedCode++;
        }
      }
      // A finding a disproof dropped is listed with the judge's drops, and a lead left unsettled only under `leads`.
      const refuted = [
        ...(round.findings?.entries ?? []), ...(round.findings?.unposted ?? []), ...(round.judge?.dropped ?? []).map(d => ({ ...d, severity: 'ignore' })),
        ...(round.leads ?? []).filter(l => l.outcome === 'unsettled' && !l.posted),
      ];
      // A reused answer is the stored one, so it is counted only in the round that gave it.
      // The answer holds its reason, files and code digest, so two findings never share one.
      const fresh = (refuter: string, refutation: Refutation | undefined): refutation is Refutation => {
        const answer = refutation && JSON.stringify([refuter, refutation]);
        if (!answer || answers.has(answer)) return false;
        answers.add(answer);
        return true;
      };
      for (const { severity, refutation, pairRefutation } of refuted) {
        if (fresh('first', refutation)) increment(stats.refutations, `${severity} ${outcomeOf(refutation)}`);
        if (fresh('second', pairRefutation)) increment(stats.pairRefutations, `${refutation ? outcomeOf(refutation) : 'none'} / ${outcomeOf(pairRefutation)}`);
      }
      stats.pairRefutationCalls.push(...(round.usage?.llmCalls ?? []).filter(c => c.agent === 'refute_pair'));
      const models = new Map((round.reviewers?.agentMetrics ?? []).map(a => [a.name, a.model ?? a.name]));
      for (const agent of round.reviewers?.agentMetrics ?? []) {
        const stat = finder(stats, agent.model ?? agent.name);
        stat.rounds++;
        stat.rawFindings += agent.findingsRaw ?? 0;
        stat.keptOnly += agent.keptOnly ?? 0;
        stat.keptShared += agent.keptShared ?? 0;
      }
      // Keyed by the finder's name, so its fallback and second ask join it, and two finders on one model stay apart.
      const toolUse = new Map<string, { stat: FinderStats; steps?: number; files: Set<string> }>();
      for (const call of round.usage?.llmCalls ?? []) {
        // A second read is no finder, and the second-read tally counts it.
        if (call.stage !== 'reviewer' || isSecondReadName(call.agent ?? '')) continue;
        // A fallback answers on another model, and a failed call names none, so the finder's own model keys the call.
        const stat = finder(stats, (call.agent && models.get(call.agent)) || call.model || call.agent || 'unknown');
        stat.toolSteps.push(call.toolSteps?.length ?? 0);
        if (call.stepBudget !== undefined) stat.budgetedCalls++;
        if (call.wrapUpNoted) stat.wrapUps++;
        const name = call.agent || call.model || 'unknown';
        const use = toolUse.get(name) ?? { stat, files: new Set<string>() };
        toolUse.set(name, use);
        // A failed call keeps its files but not its steps, so only a call with steps adds its files.
        if (!call.toolSteps) continue;
        use.steps = (use.steps ?? 0) + call.toolSteps.length;
        for (const file of call.filesRead ?? []) {
          const { repo, path } = readFileParts(file);
          use.files.add(repo + path);
        }
        for (const { tool, resultChars } of call.toolSteps) {
          if (tool === 'Read') {
            stat.readSteps++;
            if (resultChars !== undefined) stat.readChars.push(resultChars);
          } else if (tool === 'mcp__manki__read_file') {
            stat.readFileSteps++;
            if (resultChars !== undefined) stat.readFileChars.push(resultChars);
          } else stat.otherSteps++;
        }
      }
      // A record too large to keep `diff.perFile` does not say which files the diff changes.
      const changed = round.diff?.perFile && new Set(round.diff.perFile.map(file => file.path));
      for (const { stat, steps, files } of toolUse.values()) {
        if (steps === undefined) continue;
        stat.stepsPerRound.push(steps);
        stat.filesPerRound.push(files.size);
        const own = [...files].filter(file => !readFileParts(file).repo);
        stat.relatedFiles += files.size - own.length;
        if (!changed) continue;
        stat.filesInListedRounds += own.length;
        stat.filesInDiff += own.filter(file => changed.has(file)).length;
      }
      tallyRound(stats, round, numbered);
      if (round.judge?.verdictReason === 'verdict_reader') {
        stats.readerRounds++;
        stats.readerBlockers += round.judge.verdictTrace?.survivingBlockers.length ?? 0;
      }
      if (numbered && round.meta.round > 1) {
        stats.followUpRounds++;
        if (round.judge?.interRoundDiffTruncated || (round.judge?.interRoundDiffState ?? 'unknown') === 'unknown') stats.interRoundDiffCutOrUnknown++;
      }
    }
    stats.costPerPr.push(prCost);
    const outcomes = blockerOutcomes(pr.threadComments);
    for (const key of ['fixed', 'withdrawn', 'other'] as const) stats.blockerOutcomes[key] += outcomes[key];
    for (const approval of pr.approvals) tally(stats, 'State check approvals', `${approval.decision}: ${approval.reason}`);
    for (const reply of pr.replies) {
      if (reply.decision) tally(stats, 'Thread reply decisions', `${reply.decision.outcome}, ${reply.decision.thread}`);
      for (const call of reply.tokenService ?? []) tally(stats, 'Token service calls', tokenCallKey(call));
    }
  }
  return stats;
}

function tokenCallKey(call: TokenServiceCall): string {
  return call.status !== undefined && call.status < 300 ? `${call.endpoint} ok` : `${call.endpoint} failed: ${call.status ?? call.error ?? 'unknown'}`;
}

/**
 * Whether `round` holds the number after `previous`, or 1 when it is the first record in posting order. A round numbers
 * itself from the earlier records it could read, so a round after a failed read can call itself round 1 again.
 */
function inSequence(round: RoundContext, previous: RoundContext | undefined): boolean {
  return round.meta.round === (previous ? previous.meta.round + 1 : 1);
}

/**
 * Returns why the round records of `pr` are not rounds 1, 2, 3 in posting order, or `undefined` when they are. A record
 * that did not decode may hold any round, so it counts as a gap.
 */
export function roundNumbering(pr: Pick<PrRecords, 'rounds' | 'undecodedRounds'>): string | undefined {
  if (pr.undecodedRounds > 0) return `${pr.undecodedRounds} round ${pr.undecodedRounds === 1 ? 'record' : 'records'} did not decode`;
  const index = pr.rounds.findIndex((round, i) => !inSequence(round, i > 0 ? pr.rounds[i - 1] : undefined));
  return index < 0 ? undefined : `record ${index + 1} in posting order is of round ${pr.rounds[index].meta.round}, not ${index + 1}`;
}

/**
 * Whether a later round's `origin` tags can be trusted. A round without the change the round before reviewed tags every
 * finding `new`, and says so with `originsWithoutPrior` from 7.5.0 on. A round without the diff since the last round can
 * tag a line a push deleted or restored `reviewed`, and records `judge.interRoundDiffState` as `unknown` or not at all.
 */
export function originsProven(round: RoundContext): boolean {
  const diffState = round.judge?.interRoundDiffState;
  return (compareVersions(round.meta.mankiVersion, ORIGINS_PROVEN_FROM) ?? -1) >= 0 && !round.findings?.originsWithoutPrior
    && diffState !== undefined && diffState !== 'unknown';
}

/**
 * Adds the blockers and warnings `round` posted to `found`. Each counts in the round that first raised it: round 1, or a
 * later round when it sits on code an earlier round reviewed. A pre-existing finding counts in neither. A later round
 * that posted one but cannot prove its origins counts as unproven instead, and so does a record out of sequence.
 */
function tallyFirstRound(found: FirstRoundPr, round: RoundContext, previous: RoundContext | undefined, posted: FindingFingerprintEntry[]): void {
  const graded = posted.filter((entry): entry is FindingFingerprintEntry & { severity: FirstRoundGrade } =>
    (FIRST_ROUND_GRADES as readonly string[]).includes(entry.severity) && !entry.tags?.includes(PRE_EXISTING_TAG));
  if (!inSequence(round, previous)) {
    if (previous) found.unproven++;
    else found.noFirstRound = true;
    return;
  }
  if (!previous) {
    for (const entry of graded) found.grades[entry.severity].firstRound++;
    return;
  }
  if (graded.length === 0) return;
  if (!originsProven(round) || graded.some(entry => !entry.origin)) {
    found.unproven++;
    return;
  }
  for (const entry of graded) if (entry.origin === 'reviewed') found.grades[entry.severity].later++;
}

function fromSweep(finding: { reviewers?: string[] }): boolean {
  return !!finding.reviewers?.some(isSweepName);
}

/** Adds what one round's sweeps did, except the findings of theirs it posted, which `computeStats` counts with the round's other findings. */
function tallySweeps({ sweeps }: ReviewStats, round: RoundContext): void {
  if (!round.sweeps?.length) return;
  sweeps.rounds++;
  for (const sweep of round.sweeps) {
    sweeps.statuses[sweep.status]++;
    if (sweep.findings) {
      sweeps.withPlaces++;
      sweeps.places += sweep.findings;
    }
  }
  sweeps.unposted += (round.findings?.unposted ?? []).filter(fromSweep).length;
  sweeps.dropped += (round.judge?.dropped ?? []).filter(fromSweep).length;
  // A record from before `LLMCall.sweep` names only the sweep calls and the judge call on their findings.
  sweeps.calls.push(...(round.usage?.llmCalls ?? []).filter(c => c.stage === 'sweep' || c.agent === 'sweep' || c.sweep));
}

/**
 * Adds the decisions one round records to the tallies. Records from before a field existed add nothing for it. Unless
 * the PR's records are `numbered`, the rounds a carried warning waited are not known.
 */
function tallyRound(stats: ReviewStats, round: RoundContext, numbered: boolean): void {
  tallySweeps(stats, round);
  for (const [stage, digests] of Object.entries(round.meta.promptVersions ?? {})) {
    for (const digest of digests) tally(stats, 'Prompt versions (rounds per stage and digest)', `${stage} ${digest}`);
  }
  if (round.meta.needsHuman) tally(stats, 'Pause causes', round.meta.needsHuman.cause);
  for (const source of [...(round.staticAnalysis?.sources ?? []).map(s => ({ ...s, name: s.source })), ...(round.staticAnalysis?.analyzers ?? []).map(a => ({ ...a, name: a.analyzer }))]) {
    tally(stats, 'Static analysis sources', source.status === 'ran' ? `${source.name} ran` : `${source.name} skipped: ${source.reason ?? 'no reason'}`);
  }
  const entries = [...(round.findings?.entries ?? []), ...(round.findings?.unposted ?? [])];
  for (const step of [...entries, ...(round.judge?.dropped ?? [])].flatMap(f => f.gradePath ?? [])) {
    tally(stats, 'Grade changes', `${step.by}: ${step.from} to ${step.to}`);
  }
  for (const entry of entries) if (entry.preExisting) tally(stats, 'Pre-existing claims (how each was checked)', entry.preExisting.check);
  // A record written before the judge answered about a rule has the quote alone.
  for (const { rule, severity } of [...entries, ...(round.judge?.dropped ?? []).map(drop => ({ ...drop, severity: 'dropped' }))]) {
    if (rule) tally(stats, 'Rule findings (the judge\'s answer and the grade)', `${rule.verdict ?? 'not judged'}, ${severity}`);
  }
  if (round.memory?.loaded) {
    stats.learningsLoaded.push(round.memory.loaded.learnings);
    stats.suppressionsLoaded.push(round.memory.loaded.suppressions);
  }
  for (const hidden of round.memory?.suppressed ?? []) {
    tally(stats, 'Memory suppressions (findings hidden per suppression)', hidden.suppressionId);
    tally(stats, 'Findings recorded without posting (per reason and severity)', `memory_suppression, ${hidden.severity}`);
  }
  for (const entry of round.findings?.unposted ?? []) {
    tally(stats, 'Findings recorded without posting (per reason and severity)', `${entry.unpostedReason ?? entry.preExisting?.check ?? 'no reason recorded'}, ${entry.severity}`);
  }
  for (const entry of numbered ? round.findings?.carried ?? [] : []) {
    const rounds = round.meta.round - (entry.raisedIn ?? round.meta.round);
    tally(stats, 'Warnings carried from an earlier review body (listed again per rounds since first listed, ended per reason)', `listed again, ${rounds} ${rounds === 1 ? 'round' : 'rounds'} on`);
  }
  for (const end of round.findings?.carriedEnded ?? []) {
    tally(stats, 'Warnings carried from an earlier review body (listed again per rounds since first listed, ended per reason)', `ended, ${end.reason}`);
  }
  // A drop's last grade step names its reason and the severity before it. A record too large to keep `judge.dropped` has only the counts.
  const dropSteps = (round.judge?.dropped ?? []).flatMap(drop => drop.gradePath?.at(-1) ?? []).filter(step => step.to === 'ignore');
  const withSeverity = (reason: string): number => {
    const steps = dropSteps.filter(step => step.by === reason);
    for (const step of steps) tally(stats, 'Findings recorded without posting (per reason and severity)', `${reason}, ${step.from}`);
    return steps.length;
  };
  const dropCounts = {
    in_pr_suppression: round.judge?.inPrSuppressedCount,
    ratchet: round.judge?.ratchetSuppressedCount,
    resolved_thread: round.judge?.resolvedThreadSuppressedCount,
    own_proposal: round.judge?.ownProposalDemotedCount,
    test_file: round.dedup?.testNitSuppressedCount,
    static_signal: round.dedup?.staticSignalMatches?.length,
  };
  for (const [reason, count] of Object.entries(dropCounts)) {
    const unsplit = (count ?? 0) - withSeverity(reason);
    if (unsplit > 0) tally(stats, 'Findings recorded without posting (per reason and severity)', `${reason}, severity not recorded`, unsplit);
  }
  if (round.slicing) {
    stats.slicesPerRound.push(round.slicing.files.length);
    for (const slice of round.slicing.reader ?? []) tally(stats, 'Verdict reader per slice', slice.verdict);
  }
  if (round.secondReads) {
    const added = round.secondReads.reads.reduce((sum, read) => sum + (read.added ?? 0), 0);
    tally(stats, 'Second reads (per round: reads run, blockers and warnings added, why they stopped)', `${round.secondReads.reads.length} run, ${added} added, ${round.secondReads.stop}`);
  }
  if (round.approval) tally(stats, 'Approvals', round.approval.held ? `held: ${round.approval.held}` : 'approved');
  if (round.diff?.changedSinceLastRound !== undefined) stats.changedSinceLastRound.push(round.diff.changedSinceLastRound);
  if (round.judge?.fixClaimedThreads !== undefined) stats.fixClaims.push(round.judge.fixClaimedThreads.length);
  for (const call of round.tokenService ?? []) tally(stats, 'Token service calls', tokenCallKey(call));
  for (const related of round.relatedRepos ?? []) {
    const stat = stats.relatedRepos.get(related.repo) ?? { rounds: 0, reads: [], failed: 0, skipped: 0 };
    stats.relatedRepos.set(related.repo, stat);
    stat.rounds++;
    if (related.reads) stat.reads.push(related.reads);
    if (related.status === 'failed') stat.failed++;
    if (related.status === 'skipped') stat.skipped++;
  }
  const week = weekOf(round.meta.timestamp);
  for (const limit of round.usage?.limits ?? []) {
    const key = JSON.stringify([week, limit.account, limit.window]);
    const found = stats.limits.get(key) ?? { week, account: limit.account, window: limit.window, highest: 0, roundsPast: LIMIT_MARKS.map(() => 0) };
    found.highest = Math.max(found.highest, limit.usedPercent);
    LIMIT_MARKS.forEach((mark, i) => { if (limit.usedPercent >= mark) found.roundsPast[i]++; });
    stats.limits.set(key, found);
  }
}

/** The Monday of the UTC week `timestamp` falls in, such as `2026-11-09`, or `unknown` for a timestamp that does not parse. */
function weekOf(timestamp: string): string {
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return 'unknown';
  const day = new Date(time);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

function summary(values: number[], digits = 1): string {
  if (values.length === 0) return '-';
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  const median = sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return `mean ${mean.toFixed(digits)}, median ${median.toFixed(digits)}, max ${sorted.at(-1)!.toFixed(digits)}`;
}

function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}% (${part} of ${whole})` : '-';
}

/** Returns the priced cost of `calls` in USD, and the same as text that also counts the calls without a known price. */
function pricedCost(calls: LLMCall[]): { usd: number; text: string } {
  const { estimatedCostUsd, unpricedCalls } = summarizeCalls(calls);
  return { usd: estimatedCostUsd, text: `${estimatedCostUsd.toFixed(2)} USD${unpricedCalls > 0 ? ` plus ${unpricedCalls} unpriced ${unpricedCalls === 1 ? 'call' : 'calls'}` : ''}` };
}

/**
 * Returns the lines on the second refuter: how often it agreed with the first, split from it, and changed the outcome
 * the first alone would give, which it does on a split or when it settles what the first left unsettled or never answered.
 */
function pairRefutationLines({ pairRefutations, pairRefutationCalls }: ReviewStats): string[] {
  const pairs = [...pairRefutations.entries()].map(([key, n]) => ({ key, n, first: key.split(' / ')[0], second: key.split(' / ')[1] }));
  const checked = pairs.reduce((sum, p) => sum + p.n, 0);
  if (checked === 0 && pairRefutationCalls.length === 0) return ['No second refuter.'];
  const count = (test: (p: { first: string; second: string }) => boolean) => pairs.filter(test).reduce((sum, p) => sum + p.n, 0);
  const split = (p: { first: string; second: string }) => [p.first, p.second].sort().join() === 'confirmed,disproved';
  return [
    `- Findings checked: ${checked}, for ${pricedCost(pairRefutationCalls).text}`,
    `- Agreed with the first refuter: ${share(count(p => p.first === p.second), checked)}`,
    `- Split, one confirmed and one disproved: ${share(count(split), checked)}`,
    `- Changed the outcome the first refuter alone gave: ${share(count(p => split(p) || (p.second !== 'unsettled' && ['none', 'unsettled'].includes(p.first))), checked)}`,
    '',
    '| first / second | count |',
    '| --- | ---: |',
    ...pairs.sort((a, b) => b.n - a.n).map(p => `| ${p.key} | ${p.n} |`),
  ];
}

/**
 * Returns the lines on the sweeps: how they ended, where the places they reported went, what became of their findings
 * against every other finding, and what the sweeps and the calls on what they reported cost. The fix rate is keyed by the
 * first reviewer a finding names.
 */
function sweepLines({ sweeps, rounds, fixRate, costPerRound }: ReviewStats): string[] {
  if (sweeps.rounds === 0) return ['No sweeps.'];
  const posted = [...sweeps.posted.values()].reduce((sum, n) => sum + n, 0);
  const bySeverity = [...SEVERITIES, ...[...sweeps.posted.keys()].filter(s => !SEVERITIES.includes(s))].flatMap(s => sweeps.posted.has(s) ? [`${sweeps.posted.get(s)} ${s}`] : []);
  const fates = new Map<string, { posted: number; fixed: number; dismissed: number; untouched: number }>();
  for (const [specialist, totals] of fixRate.get('specialist') ?? []) {
    const row = isSweepName(specialist) ? 'a sweep' : 'any other source';
    const sum = fates.get(row) ?? { posted: 0, fixed: 0, dismissed: 0, untouched: 0 };
    for (const key of ['posted', 'fixed', 'dismissed', 'untouched'] as const) sum[key] += totals[key];
    fates.set(row, sum);
  }
  const cost = pricedCost(sweeps.calls);
  const total = costPerRound.reduce((sum, n) => sum + n, 0);
  return [
    `- Rounds that started a sweep: ${share(sweeps.rounds, rounds)}`,
    `- Sweeps: ${SWEEP_STATUSES.map(status => `${sweeps.statuses[status]} ${status}`).join(', ')}`,
    `- Sweeps that reported another place: ${share(sweeps.withPlaces, sweeps.statuses.answered)} of those answered, ${sweeps.places} places in all`,
    `- Findings of a sweep: ${posted} posted${bySeverity.length > 0 ? ` (${bySeverity.join(', ')})` : ''}, ${sweeps.unposted} recorded without posting, ${sweeps.dropped} dropped by the judge. A place that restates another finding, one a memory suppression hid and one the judge left as an open lead count in none of the three.`,
    `- Cost of the sweep calls and of the dedup, judge and refuter calls that ran only for what they reported: ${cost.text}${total > 0 ? `, ${Math.round((cost.usd / total) * 100)}% of the cost of all rounds` : ''}`,
    '',
    ...renderTable('raised by', fates),
  ];
}

/** Returns the table of what each finder model's tool calls took and read per round, over the rounds that record its steps. */
function finderToolLines(finders: [string, FinderStats][]): string[] {
  const recorded = finders.filter(([, f]) => f.stepsPerRound.length > 0);
  if (recorded.length === 0) return ['No finder tool steps recorded.'];
  return [
    'Per finder and round. A file counts once per finder and round. The share in the diff counts only the files of the PR\'s own repo. The finder\'s prompt already shows a file the diff changes, unless the file did not fit the prompt\'s size budget. `Read` is the CLI\'s built-in tool, which returns up to 25,000 tokens of a file per call, and `read_file` is Manki\'s own, which returns up to 20,000 characters per call. The characters per step are the text a step\'s result gave the model, which shows how close the reads come to either limit, and count only the steps whose record keeps them. A call whose record lists no tool steps, as an older record of a Codex call, counts in none of these. A call that failed keeps its files but not its steps, so it counts in none of these either.',
    '',
    '| model | finder rounds | tool steps per round | files read per round | files read in a related repo | own files read that the diff changes | `Read` steps | characters per `Read` step | `read_file` steps | characters per `read_file` step | other steps |',
    '| --- | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | --- | ---: |',
    ...recorded.map(([model, f]) => `| ${model} | ${f.stepsPerRound.length} | ${summary(f.stepsPerRound)} | ${summary(f.filesPerRound)} | ${f.relatedFiles} | ${share(f.filesInDiff, f.filesInListedRounds)} | ${f.readSteps} | ${summary(f.readChars, 0)} | ${f.readFileSteps} | ${summary(f.readFileChars, 0)} | ${f.otherSteps} |`),
  ];
}

/**
 * Returns the lines on the blockers and warnings found in round 1: the totals per grade over the PRs whose records prove
 * them, the PRs left out, and a row per counted PR that posted one.
 */
function firstRoundLines(prs: FirstRoundPr[]): string[] {
  const counted = prs.filter(pr => !pr.noFirstRound && pr.unproven === 0);
  const left = prs.filter(pr => pr.noFirstRound || pr.unproven > 0);
  const cells = (of: FirstRoundPr[], grades: readonly FirstRoundGrade[]) => {
    const sum = (key: 'firstRound' | 'later') => of.reduce((n, pr) => n + grades.reduce((m, grade) => m + pr.grades[grade][key], 0), 0);
    const [firstRound, later] = [sum('firstRound'), sum('later')];
    return { firstRound, later, share: share(firstRound, firstRound + later) };
  };
  const total = (grades: readonly FirstRoundGrade[]) => {
    const c = cells(counted, grades);
    return `${c.firstRound} | ${c.later} | ${c.share}`;
  };
  const rows = counted.flatMap((pr) => {
    const [blocker, warning, both] = [cells([pr], ['blocker']), cells([pr], ['warning']), cells([pr], FIRST_ROUND_GRADES)];
    return both.firstRound + both.later > 0
      ? [`| #${pr.number} | ${blocker.firstRound} | ${warning.firstRound} | ${blocker.later} | ${warning.later} | ${both.share} |`]
      : [];
  });
  const records = left.reduce((n, pr) => n + pr.unproven, 0);
  const noFirstRound = left.filter(pr => pr.noFirstRound).length;
  return [
    '| grade | round 1 | later, on code an earlier round reviewed | found in round 1 |',
    '| --- | ---: | ---: | ---: |',
    ...FIRST_ROUND_GRADES.map(grade => `| ${grade} | ${total([grade])} |`),
    `| both | ${total(FIRST_ROUND_GRADES)} |`,
    '',
    `A blocker or warning counts once, in the round that first raised it. A finding of a later round counts only when it sits on code an earlier round reviewed, so one on code a push changed since the round before counts in neither column. A finding round 1 posted counts even when its thread was resolved later. A pre-existing finding counts in neither. The record says only that an earlier round reviewed the lines, not which one, so a later finding on code a push after round 1 added counts as late too. A PR counts only when its records prove where each finding was first raised: every record decodes, its first record in posting order is of round 1, each later record is of the round after the one before, and each later round that posted a blocker or warning ${ORIGINS_PROVEN_TEXT}.`,
    ...(left.length > 0
      ? ['', `${left.length} ${left.length === 1 ? 'PR' : 'PRs'} left out (${left.map(pr => `#${pr.number}`).join(', ')}): ${noFirstRound} without a round 1 record, ${records} round ${records === 1 ? 'record' : 'records'} that cannot say where a finding was first raised.`]
      : []),
    ...(rows.length > 0
      ? ['', '| PR | round 1 blockers | round 1 warnings | later blockers | later warnings | found in round 1 |', '| --- | ---: | ---: | ---: | ---: | ---: |', ...rows]
      : []),
  ];
}

/** Renders the report, headed with `repo` when one is given. */
export function renderStats(stats: ReviewStats, repo?: string): string {
  const per = (count: number, rounds: number) => (rounds > 0 ? (count / rounds).toFixed(2) : '-');
  const all = noFindings();
  for (const severity of Object.values(stats.severities)) {
    for (const key of Object.keys(all) as (keyof SeverityStats)[]) all[key] += severity[key];
  }
  const findingsRow = (name: string, s = noFindings()) =>
    `| ${name} | ${s.posted} | ${per(s.posted, stats.rounds)} | ${s.inApprovedRounds} | ${per(s.inApprovedRounds, stats.approvedRounds)} | ${share(s.onReviewedCode, s.raisedLater)} |`;
  const finders = [...stats.finders.entries()].sort((a, b) => b[1].rounds - a[1].rounds || a[0].localeCompare(b[0]));
  const blockerThreads = stats.blockerOutcomes.fixed + stats.blockerOutcomes.withdrawn + stats.blockerOutcomes.other;
  const lines = [
    `# Review statistics${repo ? ` for ${repo}` : ''} over ${stats.prs} merged PRs and ${stats.rounds} rounds`,
    '',
    ...(stats.unreviewed > 0
      ? [`${stats.unreviewed} more merged ${stats.unreviewed === 1 ? 'PR has no record of a completed round and is' : 'PRs have no record of a completed round and are'} left out.`, '']
      : []),
    '## Rounds',
    '',
    `- Rounds per PR: ${summary(stats.roundsPerPr)}`,
    `- Passed after one round: ${share(stats.passedFirstRound, stats.numberedPrs)}`,
    `- Needed ${MANY_ROUNDS} or more rounds: ${share(stats.manyRounds, stats.prs)}`,
    `- Rounds that ended incomplete, counted in no other figure: ${stats.incompleteRounds}`,
    `- PRs left out of the share passed after one round, the findings first raised in a later round, the follow-up rounds and the rounds a carried warning waited, because a round record did not decode or the records are not rounds 1, 2, 3 in posting order: ${stats.prs - stats.numberedPrs}`,
    `- Approved rounds: ${share(stats.approvedRounds, stats.rounds)}`,
    `- PRs with rounds after their first approval: ${share(stats.roundsAfterApproval.length, stats.prs)}, ${stats.roundsAfterApproval.reduce((sum, n) => sum + n, 0)} such rounds`,
    '',
    '## Findings',
    '',
    '| severity | total | per round | in approved rounds | per approved round | first raised in a later round, on code an earlier round reviewed |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...[...SEVERITIES, ...Object.keys(stats.severities).filter(s => !SEVERITIES.includes(s))].map(s => findingsRow(s, stats.severities[s])),
    findingsRow('all', all),
    '',
    'The table leaves out a finding the round put under an earlier Manki thread, such as another instance of a finding that went into its thread as a reply. A record from before the `posted` field does not say where a finding went. For those the script leaves out a finding that names an earlier thread, or that matches one by file, title and line. It cannot tell whether that thread was still open, so it also leaves out a blocker posted again after its old thread was resolved. A finding first raised in a later round counts only when that round ' + ORIGINS_PROVEN_TEXT + '. A round without the earlier round\'s change, which is a "Review again" run or a failed fetch of the change at the last reviewed commit, tags every finding `new`. A round without the diff since the last round can tag a line a push deleted or restored as reviewed. A note on reviewed code is not posted, so it counts in none of these either, and shows under `reviewed_code` in the table of findings recorded without posting.',
    '',
    `- Blocker threads: ${blockerThreads}, fixed ${stats.blockerOutcomes.fixed}, withdrawn ${stats.blockerOutcomes.withdrawn}, other ${stats.blockerOutcomes.other}`,
    `- Verdict reader blockers: ${stats.readerBlockers} in ${stats.readerRounds} rounds`,
    '',
    '## Found in round 1',
    '',
    ...firstRoundLines(stats.firstRound),
    '',
    '## Fix rate',
    '',
    'From `metrics/fix-rate.jsonl`, for the PRs above. A finding counts as fixed when the judge marked its thread addressed or a later commit touched its lines, whether or not that commit fixed it.',
    '',
    ...renderTable('severity', stats.fixRate.get('severity') ?? new Map()),
    '',
    ...renderTable('checkStatus', stats.fixRate.get('checkStatus') ?? new Map()),
    '',
    '## Finders',
    '',
    '| model | rounds | raw findings | per round | kept only by it | kept with another | tool steps per call | told to wrap up |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |',
    ...finders.map(([model, f]) => `| ${model} | ${f.rounds} | ${f.rawFindings} | ${f.rounds > 0 ? (f.rawFindings / f.rounds).toFixed(2) : '-'} | ${f.keptOnly} | ${f.keptShared} | ${summary(f.toolSteps)} | ${share(f.wrapUps, f.budgetedCalls)} |`),
    '',
    '## Finder tool use',
    '',
    ...finderToolLines(finders),
    '',
    '## Refutations',
    '',
    ...(stats.refutations.size > 0
      ? ['| severity and outcome | count |', '| --- | ---: |', ...[...stats.refutations.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => `| ${key} | ${n} |`)]
      : ['No refutations.']),
    '',
    '## Second refuter',
    '',
    ...pairRefutationLines(stats),
    '',
    '## Sweeps',
    '',
    ...sweepLines(stats),
    '',
    '## Cost and inter-round diffs',
    '',
    `- Cost per PR in USD: ${summary(stats.costPerPr, 2)}`,
    `- Cost per round in USD: ${summary(stats.costPerRound, 2)}`,
    `- Follow-up rounds whose inter-round diff was cut or unknown: ${share(stats.interRoundDiffCutOrUnknown, stats.followUpRounds)}`,
    `- Files changed since the last round, per follow-up round: ${summary(stats.changedSinceLastRound)}`,
    `- Threads with a fix claim, per round: ${summary(stats.fixClaims)}`,
    `- Memory loaded per round: learnings ${summary(stats.learningsLoaded)}, suppressions ${summary(stats.suppressionsLoaded)}`,
    `- Slices per round read in slices: ${summary(stats.slicesPerRound)}`,
    '',
    '## Related repositories',
    '',
    ...(stats.relatedRepos.size > 0
      ? [
        '| repo | rounds it was configured | rounds that read it | reads per round that read it | fetch failures | skipped rounds |',
        '| --- | ---: | ---: | --- | ---: | ---: |',
        ...[...stats.relatedRepos.entries()].sort((a, b) => b[1].rounds - a[1].rounds || a[0].localeCompare(b[0]))
          .map(([repo, r]) => `| ${tableCell(repo)} | ${r.rounds} | ${r.reads.length} | ${summary(r.reads)} | ${r.failed} | ${r.skipped} |`),
      ]
      : ['None recorded.']),
    '',
    '## Subscription limits',
    '',
    ...(stats.limits.size > 0
      ? [
        `| week of | account | window | highest used | ${LIMIT_MARKS.map(mark => `rounds at ${mark}%+`).join(' | ')} |`,
        `| --- | --- | --- | ---: | ${LIMIT_MARKS.map(() => '---:').join(' | ')} |`,
        ...[...stats.limits.values()]
          .sort((a, b) => a.week.localeCompare(b.week) || a.account.localeCompare(b.account) || a.window.localeCompare(b.window))
          .map(l => `| ${l.week} | ${tableCell(l.account)} | ${tableCell(l.window)} | ${l.highest}% | ${l.roundsPast.join(' | ')} |`),
      ]
      : ['No limit readings recorded.']),
    '',
    '## Decisions',
    ...DECISIONS.flatMap(decision => decisionTable(decision, stats.decisions.get(decision))),
  ];
  return `${lines.join('\n')}\n`;
}

const MAX_DECISION_ROWS = 15;

/** A value from a record as one table cell, so it never breaks the table. */
function tableCell(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\|/g, '\\|');
}

function decisionTable(decision: Decision, counts: Map<string, number> | undefined): string[] {
  if (!counts || counts.size === 0) return ['', `### ${decision}`, '', 'None recorded.'];
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const more = rows.length > MAX_DECISION_ROWS ? [``, `${rows.length - MAX_DECISION_ROWS} more values are left out.`] : [];
  return [
    '', `### ${decision}`, '', '| value | count |', '| --- | ---: |',
    ...rows.slice(0, MAX_DECISION_ROWS).map(([value, count]) => `| ${tableCell(value)} | ${count} |`), ...more,
  ];
}


function parseArgs(args: string[]): { owner: string; repo: string; last: number; fixRate?: string } | undefined {
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const [owner, repo, ...rest] = (value('--repo') ?? '').split('/');
  const last = Number(value('--last') ?? DEFAULT_LAST);
  return owner && repo && rest.length === 0 && Number.isInteger(last) && last > 0 ? { owner, repo, last, fixRate: value('--fix-rate') } : undefined;
}

type Octokit = ReturnType<typeof github.getOctokit>;

/** A merged pull request as `pulls.list` returns it. */
export type MergedPr = Awaited<ReturnType<Octokit['rest']['pulls']['list']>>['data'][number] & { merged_at: string };

/** Returns the `last` most recently merged pull requests of the repository, newest first. */
export async function listMergedPrs(octokit: Octokit, owner: string, repo: string, last: number): Promise<MergedPr[]> {
  const merged: MergedPr[] = [];
  // A merged PR is updated no earlier than it merged, so once a page reaches PRs updated before the last of the newest
  // `last` merges, no later page holds a newer merge.
  for await (const { data } of octokit.paginate.iterator(octokit.rest.pulls.list, { owner, repo, state: 'closed', sort: 'updated', direction: 'desc', per_page: 100 })) {
    merged.push(...data.filter((p): p is MergedPr => !!p.merged_at));
    merged.sort((a, b) => b.merged_at.localeCompare(a.merged_at));
    const oldestUpdate = data.at(-1)?.updated_at;
    if (merged.length >= last && oldestUpdate && oldestUpdate < merged[last - 1].merged_at) break;
  }
  return merged.slice(0, last);
}

/** Reads the round records, reply records, approvals and thread comments of one pull request. */
export async function fetchPrRecords(octokit: Octokit, owner: string, repo: string, number: number): Promise<PrRecords> {
  const [reviews, threadComments, issueComments] = await Promise.all([
    octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 }),
    octokit.paginate(octokit.rest.pulls.listReviewComments, { owner, repo, pull_number: number, per_page: 100 }),
    octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 }),
  ]);
  return prRecords(`${owner}/${repo}`, number, { reviews, threadComments, issueComments });
}

async function main(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (!parsed) {
    console.error('Usage: npm run review-stats -- --repo <owner/repo> [--last <n>] [--fix-rate <fix-rate.jsonl>]');
    return 1;
  }
  const { owner, repo, last, fixRate } = parsed;
  const fixRateLines = fixRate ? readFileSync(fixRate, 'utf-8').split('\n') : [];
  const octokit = github.getOctokit(githubToken());
  const prs: PrRecords[] = [];
  for (const { number } of await listMergedPrs(octokit, owner, repo, last)) prs.push(await fetchPrRecords(octokit, owner, repo, number));
  process.stdout.write(renderStats(computeStats(prs, fixRateLines), `${owner}/${repo}`));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
