/**
 * Prints every Manki record of a pull request, or of every pull request in a repository, as one
 * JSON line per record: the round record of each review and the usage record of each reply.
 * Compressed records are decoded. With `--calls`, prints one line per LLM call instead, so usage
 * and cost can be summed per agent, stage, model, PR or repo.
 *
 * Usage:
 *   npm run review-history -- <owner/repo> [<pr number>] [--calls] > history.jsonl
 *
 * Reads the GitHub token from `GITHUB_TOKEN`, or from `gh auth token` when that is unset.
 */

import { execFileSync } from 'child_process';
import * as github from '@actions/github';

import { extractReplyRecords, extractReviewRecords, hasReviewRecord } from '../src/review-record';
import type { LLMCall } from '../src/providers';
import { migrateStoredSeverities } from '../src/types';

interface PostedLike {
  id: number;
  body?: string | null;
  user?: { login: string; type?: string } | null;
  commit_id?: string | null;
  submitted_at?: string | null;
  created_at?: string | null;
}

export interface HistoryLine {
  kind: 'round' | 'reply';
  repo: string;
  pr: number;
  /** Id of the review that holds a round record, or of the comment that holds a reply record. */
  sourceId: number;
  author?: string;
  commitId?: string;
  postedAt?: string;
  record: unknown;
}

/** Parses each record text, reporting the ones that are not JSON on stderr. */
function parseRecords(texts: string[], where: string): unknown[] {
  return texts.flatMap(text => {
    try {
      return [migrateStoredSeverities(JSON.parse(text) as unknown)];
    } catch {
      console.error(`Skipping a record that is not JSON in ${where}`);
      return [];
    }
  });
}

/**
 * Returns one line per record in what a bot posted, so text a person pasted is not taken for a
 * record. Reviews give round records, comments give reply records. A record that can't be decoded
 * or parsed is reported on stderr and skipped.
 */
export function historyLines(repo: string, pr: number, posted: { reviews: PostedLike[]; comments: PostedLike[] }): HistoryLine[] {
  const line = (kind: HistoryLine['kind'], item: PostedLike, record: unknown): HistoryLine => ({
    kind,
    repo,
    pr,
    sourceId: item.id,
    ...(item.user?.login && { author: item.user.login }),
    ...(item.commit_id && { commitId: item.commit_id }),
    ...((item.submitted_at ?? item.created_at) && { postedAt: (item.submitted_at ?? item.created_at)! }),
    record,
  });
  const lines: HistoryLine[] = [];
  for (const review of posted.reviews) {
    if (review.user?.type !== 'Bot' || !review.body || !hasReviewRecord(review.body)) continue;
    const where = `review ${review.id} on ${repo}#${pr}`;
    const { records, errors } = extractReviewRecords(review.body);
    for (const error of errors) console.error(`Skipping an undecodable record in ${where}: ${error}`);
    lines.push(...parseRecords(records, where).map(record => line('round', review, record)));
  }
  for (const comment of posted.comments) {
    if (comment.user?.type !== 'Bot' || !comment.body) continue;
    lines.push(...parseRecords(extractReplyRecords(comment.body), `comment ${comment.id} on ${repo}#${pr}`).map(record => line('reply', comment, record)));
  }
  return lines;
}

/** Returns one line per LLM call in `lines`, with where the call was recorded. Records older than per-call usage have none. */
export function callLines(lines: HistoryLine[]): Array<Omit<HistoryLine, 'record'> & { round?: number } & LLMCall> {
  return lines.flatMap(({ record, ...source }) => {
    const r = record as { meta?: { round?: number }; usage?: { llmCalls?: LLMCall[] } };
    const round = r.meta?.round;
    return (r.usage?.llmCalls ?? []).map(call => ({ ...source, ...(round !== undefined && { round }), ...call }));
  });
}

export function githubToken(): string {
  return process.env.GITHUB_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8' }).trim();
}

async function main(args: string[]): Promise<number> {
  const calls = args.includes('--calls');
  const [fullName, prArg] = args.filter(a => a !== '--calls');
  const [owner, repo] = fullName?.split('/') ?? [];
  const prNumber = prArg === undefined ? undefined : Number(prArg);
  if (!owner || !repo || (prNumber !== undefined && !Number.isInteger(prNumber))) {
    console.error('Usage: npm run review-history -- <owner/repo> [<pr number>] [--calls]');
    return 1;
  }

  const octokit = github.getOctokit(githubToken());
  const prs = prNumber !== undefined
    ? [prNumber]
    : (await octokit.paginate(octokit.rest.pulls.list, { owner, repo, state: 'all', per_page: 100 })).map(p => p.number).sort((a, b) => a - b);
  for (const pr of prs) {
    const [reviews, threadComments, issueComments] = await Promise.all([
      octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: pr, per_page: 100 }),
      octokit.paginate(octokit.rest.pulls.listReviewComments, { owner, repo, pull_number: pr, per_page: 100 }),
      octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: pr, per_page: 100 }),
    ]);
    const lines = historyLines(fullName, pr, { reviews, comments: [...threadComments, ...issueComments] });
    for (const line of calls ? callLines(lines) : lines) {
      process.stdout.write(`${JSON.stringify(line)}\n`);
    }
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
