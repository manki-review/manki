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
import type { RoundContext } from '../src/types';
import { githubToken, historyLines } from './review-history';

const DEFAULT_LAST = 40;
const MANY_ROUNDS = 5;
const SEVERITIES = ['blocker', 'warning', 'suggestion', 'nitpick'] as const;

type Posted = Parameters<typeof historyLines>[2]['reviews'][number];

interface ThreadComment extends Posted {
  in_reply_to_id?: number | null;
}

/** One merged pull request: its round records in posting order, and the comments of its review threads. */
export interface PrRecords {
  number: number;
  rounds: RoundContext[];
  threadComments: ThreadComment[];
}

interface FinderStats {
  rounds: number;
  rawFindings: number;
  keptOnlyBy: number;
  toolSteps: number[];
}

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
  keptByMany: number;
  readerRounds: number;
  readerBlockers: number;
  refutations: Map<string, number>;
  costPerPr: number[];
  costPerRound: number[];
  followUpRounds: number;
  interRoundDiffCutOrUnknown: number;
}

/** Returns the round records and thread comments of `number` from what GitHub lists for it. */
export function prRecords(repo: string, number: number, posted: { reviews: Posted[]; threadComments: ThreadComment[] }): PrRecords {
  const rounds = historyLines(repo, number, { reviews: posted.reviews, comments: [] }).map(line => line.record as RoundContext);
  return { number, rounds, threadComments: posted.threadComments };
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
  const found = stats.finders.get(model) ?? { rounds: 0, rawFindings: 0, keptOnlyBy: 0, toolSteps: [] };
  stats.finders.set(model, found);
  return found;
}

/** Adds up the statistics over `prs`. A finder is keyed by the model it ran on, or by its name in records without one. */
export function computeStats(prs: PrRecords[]): ReviewStats {
  const stats: ReviewStats = {
    prs: 0, unreviewed: 0, roundsPerPr: [], passedFirstRound: 0, manyRounds: 0, rounds: 0, severityCounts: {}, findings: 0, onReviewedCode: 0,
    blockerOutcomes: { fixed: 0, withdrawn: 0, other: 0 }, finders: new Map(), keptByMany: 0, readerRounds: 0, readerBlockers: 0,
    refutations: new Map(), costPerPr: [], costPerRound: [], followUpRounds: 0, interRoundDiffCutOrUnknown: 0,
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
      }
      for (const [name, count] of Object.entries(round.reviewers?.keptOnlyBy ?? {})) finder(stats, models.get(name) ?? name).keptOnlyBy += count;
      stats.keptByMany += round.reviewers?.keptByMany ?? 0;
      for (const call of round.usage?.llmCalls ?? []) {
        // A fallback answers on another model, and a failed call names none, so the finder's own model keys the call.
        if (call.stage === 'reviewer') finder(stats, (call.agent && models.get(call.agent)) || call.model || call.agent || 'unknown').toolSteps.push(call.toolSteps?.length ?? 0);
      }
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
  }
  return stats;
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

export function renderStats(stats: ReviewStats): string {
  const perRound = (count: number) => (stats.rounds > 0 ? (count / stats.rounds).toFixed(2) : '-');
  const finders = [...stats.finders.entries()].sort((a, b) => b[1].rounds - a[1].rounds || a[0].localeCompare(b[0]));
  const blockerThreads = stats.blockerOutcomes.fixed + stats.blockerOutcomes.withdrawn + stats.blockerOutcomes.other;
  const lines = [
    `# Review statistics over ${stats.prs} merged PRs and ${stats.rounds} rounds`,
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
    '| model | rounds | raw findings | per round | kept only by it | tool steps per call |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...finders.map(([model, f]) => `| ${model} | ${f.rounds} | ${f.rawFindings} | ${f.rounds > 0 ? (f.rawFindings / f.rounds).toFixed(2) : '-'} | ${f.keptOnlyBy} | ${summary(f.toolSteps)} |`),
    '',
    `- Kept findings raised by two or more finders: ${stats.keptByMany}`,
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
  ];
  return `${lines.join('\n')}\n`;
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
    const [reviews, threadComments] = await Promise.all([
      octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 }),
      octokit.paginate(octokit.rest.pulls.listReviewComments, { owner, repo, pull_number: number, per_page: 100 }),
    ]);
    prs.push(prRecords(`${owner}/${repo}`, number, { reviews, threadComments }));
  }
  process.stdout.write(renderStats(computeStats(prs)));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
