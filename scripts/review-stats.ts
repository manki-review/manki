/**
 * Prints review statistics for the last merged pull requests of a repository, read from Manki's round records and its
 * thread replies, so a change to the review can be compared before and after. It only reads from GitHub.
 *
 * Usage:
 *   npm run review-stats -- --repo <owner/repo> [--last <n>]
 *
 * Reads the GitHub token from `GITHUB_TOKEN`, or from `gh auth token` when that is unset.
 */

import * as github from '@actions/github';

import { replyOutcome } from '../src/interaction';
import { threadSeverity } from '../src/recap';
import { extractApprovalRecords } from '../src/review-record';
import type { ApprovalRecord, ReplyRecord, RoundContext, TokenServiceCall } from '../src/types';
import { githubToken, historyLines } from './review-history';

const DEFAULT_LAST = 40;
const MANY_ROUNDS = 5;
const SEVERITIES = ['blocker', 'warning', 'suggestion', 'nitpick'] as const;
const LIMIT_MARKS = [70, 80, 90] as const;

type Posted = Parameters<typeof historyLines>[2]['reviews'][number];

interface ThreadComment extends Posted {
  in_reply_to_id?: number | null;
}

/** One merged pull request: its round records in posting order, and the comments of its review threads. */
export interface PrRecords {
  number: number;
  rounds: RoundContext[];
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
}

/** The decision tallies the report lists, each as a table of how often each value occurred. */
const DECISIONS = [
  'Prompt versions (rounds per stage and digest)',
  'Pause causes',
  'Static analysis sources',
  'Grade changes',
  'Pre-existing claims (how each was checked)',
  'Memory suppressions (findings hidden per suppression)',
  'Verdict reader per slice',
  'Approvals',
  'State check approvals',
  'Thread reply decisions',
  'Token service calls',
] as const;

type Decision = (typeof DECISIONS)[number];

export interface ReviewStats {
  /** PRs with at least one round record. Only they count in the statistics. */
  prs: number;
  /** Merged PRs without a round record, such as one Manki never reviewed. */
  unreviewed: number;
  roundsPerPr: number[];
  passedFirstRound: number;
  manyRounds: number;
  rounds: number;
  severityCounts: Record<string, number>;
  findings: number;
  onReviewedCode: number;
  blockerOutcomes: { fixed: number; withdrawn: number; other: number };
  finders: Map<string, FinderStats>;
  readerRounds: number;
  readerBlockers: number;
  refutations: Map<string, number>;
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

function tally(stats: ReviewStats, decision: Decision, value: string, by = 1): void {
  const counts = stats.decisions.get(decision) ?? new Map<string, number>();
  counts.set(value, (counts.get(value) ?? 0) + by);
  stats.decisions.set(decision, counts);
}

/** Returns the round records and thread comments of `number` from what GitHub lists for it. */
export function prRecords(
  repo: string, number: number, posted: { reviews: Posted[]; threadComments: ThreadComment[]; issueComments?: Posted[] },
): PrRecords {
  const lines = historyLines(repo, number, { reviews: posted.reviews, comments: posted.threadComments });
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
  return {
    number,
    rounds: lines.filter(line => line.kind === 'round').map(line => line.record as RoundContext),
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
    const last = byBot.filter(c => c.in_reply_to_id === root.id).map(c => replyOutcome(c.body!.trim())).filter(o => o !== undefined).at(-1);
    if (last === 'Fixed') outcomes.fixed++;
    else if (last === 'Withdrawn') outcomes.withdrawn++;
    else outcomes.other++;
  }
  return outcomes;
}

function finder(stats: ReviewStats, model: string): FinderStats {
  const found = stats.finders.get(model) ?? { rounds: 0, rawFindings: 0, keptOnly: 0, keptShared: 0, toolSteps: [], budgetedCalls: 0, wrapUps: 0 };
  stats.finders.set(model, found);
  return found;
}

/** Adds up the statistics over `prs`. A finder is keyed by the model it ran on, or by its name in records without one. */
export function computeStats(prs: PrRecords[]): ReviewStats {
  const stats: ReviewStats = {
    prs: 0, unreviewed: 0, roundsPerPr: [], passedFirstRound: 0, manyRounds: 0, rounds: 0, severityCounts: {}, findings: 0, onReviewedCode: 0,
    blockerOutcomes: { fixed: 0, withdrawn: 0, other: 0 }, finders: new Map(), readerRounds: 0, readerBlockers: 0,
    refutations: new Map(), costPerPr: [], costPerRound: [], followUpRounds: 0, interRoundDiffCutOrUnknown: 0,
    decisions: new Map(), learningsLoaded: [], suppressionsLoaded: [], slicesPerRound: [], changedSinceLastRound: [], fixClaims: [],
    relatedRepos: new Map(), limits: new Map(),
  };
  for (const pr of prs) {
    if (pr.rounds.length === 0) {
      stats.unreviewed++;
      continue;
    }
    stats.prs++;
    stats.roundsPerPr.push(pr.rounds.length);
    if (pr.rounds[0]?.meta.outcome === 'READY') stats.passedFirstRound++;
    if (pr.rounds.length >= MANY_ROUNDS) stats.manyRounds++;
    let prCost = 0;
    for (const round of pr.rounds) {
      stats.rounds++;
      const cost = round.usage?.estimatedCostUsd ?? 0;
      prCost += cost;
      stats.costPerRound.push(cost);
      for (const entry of round.findings?.entries ?? []) {
        stats.findings++;
        stats.severityCounts[entry.severity] = (stats.severityCounts[entry.severity] ?? 0) + 1;
        if (entry.origin === 'reviewed') stats.onReviewedCode++;
        if (entry.refutation) {
          const key = `${entry.severity} ${entry.refutation.outcome}`;
          stats.refutations.set(key, (stats.refutations.get(key) ?? 0) + 1);
        }
      }
      const models = new Map((round.reviewers?.agentMetrics ?? []).map(a => [a.name, a.model ?? a.name]));
      for (const agent of round.reviewers?.agentMetrics ?? []) {
        const stat = finder(stats, agent.model ?? agent.name);
        stat.rounds++;
        stat.rawFindings += agent.findingsRaw ?? 0;
        stat.keptOnly += agent.keptOnly ?? 0;
        stat.keptShared += agent.keptShared ?? 0;
      }
      for (const call of round.usage?.llmCalls ?? []) {
        if (call.stage !== 'reviewer') continue;
        // A fallback answers on another model, and a failed call names none, so the finder's own model keys the call.
        const stat = finder(stats, (call.agent && models.get(call.agent)) || call.model || call.agent || 'unknown');
        stat.toolSteps.push(call.toolSteps?.length ?? 0);
        if (call.stepBudget !== undefined) stat.budgetedCalls++;
        if (call.wrapUpNoted) stat.wrapUps++;
      }
      tallyRound(stats, round);
      if (round.judge?.verdictReason === 'verdict_reader') {
        stats.readerRounds++;
        stats.readerBlockers += round.judge.verdictTrace?.survivingBlockers.length ?? 0;
      }
      if (round.meta.round > 1) {
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

/** Adds the decisions one round records to the tallies. Records from before a field existed add nothing for it. */
function tallyRound(stats: ReviewStats, round: RoundContext): void {
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
  if (round.memory?.loaded) {
    stats.learningsLoaded.push(round.memory.loaded.learnings);
    stats.suppressionsLoaded.push(round.memory.loaded.suppressions);
  }
  for (const hidden of round.memory?.suppressed ?? []) tally(stats, 'Memory suppressions (findings hidden per suppression)', hidden.suppressionId);
  if (round.slicing) {
    stats.slicesPerRound.push(round.slicing.files.length);
    for (const slice of round.slicing.reader ?? []) tally(stats, 'Verdict reader per slice', slice.verdict);
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

/** Renders the report, headed with `repo` when one is given. */
export function renderStats(stats: ReviewStats, repo?: string): string {
  const perRound = (count: number) => (stats.rounds > 0 ? (count / stats.rounds).toFixed(2) : '-');
  const finders = [...stats.finders.entries()].sort((a, b) => b[1].rounds - a[1].rounds || a[0].localeCompare(b[0]));
  const blockerThreads = stats.blockerOutcomes.fixed + stats.blockerOutcomes.withdrawn + stats.blockerOutcomes.other;
  const lines = [
    `# Review statistics${repo ? ` for ${repo}` : ''} over ${stats.prs} merged PRs and ${stats.rounds} rounds`,
    '',
    ...(stats.unreviewed > 0
      ? [`${stats.unreviewed} more merged ${stats.unreviewed === 1 ? 'PR has no round record and is' : 'PRs have no round record and are'} left out.`, '']
      : []),
    '## Rounds',
    '',
    `- Rounds per PR: ${summary(stats.roundsPerPr)}`,
    `- Passed after one round: ${share(stats.passedFirstRound, stats.prs)}`,
    `- Needed ${MANY_ROUNDS} or more rounds: ${share(stats.manyRounds, stats.prs)}`,
    '',
    '## Findings',
    '',
    '| severity | total | per round |',
    '| --- | ---: | ---: |',
    ...[...SEVERITIES, ...Object.keys(stats.severityCounts).filter(s => !(SEVERITIES as readonly string[]).includes(s))]
      .map(s => `| ${s} | ${stats.severityCounts[s] ?? 0} | ${perRound(stats.severityCounts[s] ?? 0)} |`),
    '',
    `- On code an earlier round reviewed: ${share(stats.onReviewedCode, stats.findings)}`,
    `- Blocker threads: ${blockerThreads}, fixed ${stats.blockerOutcomes.fixed}, withdrawn ${stats.blockerOutcomes.withdrawn}, other ${stats.blockerOutcomes.other}`,
    `- Verdict reader blockers: ${stats.readerBlockers} in ${stats.readerRounds} rounds`,
    '',
    '## Finders',
    '',
    '| model | rounds | raw findings | per round | kept only by it | kept with another | tool steps per call | told to wrap up |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |',
    ...finders.map(([model, f]) => `| ${model} | ${f.rounds} | ${f.rawFindings} | ${f.rounds > 0 ? (f.rawFindings / f.rounds).toFixed(2) : '-'} | ${f.keptOnly} | ${f.keptShared} | ${summary(f.toolSteps)} | ${share(f.wrapUps, f.budgetedCalls)} |`),
    '',
    '## Refutations',
    '',
    ...(stats.refutations.size > 0
      ? ['| severity and outcome | count |', '| --- | ---: |', ...[...stats.refutations.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => `| ${key} | ${n} |`)]
      : ['No refutations.']),
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


function parseArgs(args: string[]): { owner: string; repo: string; last: number } | undefined {
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const [owner, repo, ...rest] = (value('--repo') ?? '').split('/');
  const last = Number(value('--last') ?? DEFAULT_LAST);
  return owner && repo && rest.length === 0 && Number.isInteger(last) && last > 0 ? { owner, repo, last } : undefined;
}

async function main(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (!parsed) {
    console.error('Usage: npm run review-stats -- --repo <owner/repo> [--last <n>]');
    return 1;
  }
  const { owner, repo, last } = parsed;
  const octokit = github.getOctokit(githubToken());
  const merged: Array<{ number: number; merged_at: string }> = [];
  // A merged PR is updated no earlier than it merged, so once a page reaches PRs updated before the last of the newest
  // `last` merges, no later page holds a newer merge.
  for await (const { data } of octokit.paginate.iterator(octokit.rest.pulls.list, { owner, repo, state: 'closed', sort: 'updated', direction: 'desc', per_page: 100 })) {
    merged.push(...data.flatMap(p => (p.merged_at ? [{ number: p.number, merged_at: p.merged_at }] : [])));
    merged.sort((a, b) => b.merged_at.localeCompare(a.merged_at));
    const oldestUpdate = data.at(-1)?.updated_at;
    if (merged.length >= last && oldestUpdate && oldestUpdate < merged[last - 1].merged_at) break;
  }
  const numbers = merged.slice(0, last).map(p => p.number);
  const prs: PrRecords[] = [];
  for (const number of numbers) {
    const [reviews, threadComments, issueComments] = await Promise.all([
      octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 }),
      octokit.paginate(octokit.rest.pulls.listReviewComments, { owner, repo, pull_number: number, per_page: 100 }),
      octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 }),
    ]);
    prs.push(prRecords(`${owner}/${repo}`, number, { reviews, threadComments, issueComments }));
  }
  process.stdout.write(renderStats(computeStats(prs), `${owner}/${repo}`));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
