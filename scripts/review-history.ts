/**
 * Prints every Manki round record of a pull request, or of every pull request in a repository,
 * as one JSON line per record. Compressed records are decoded.
 *
 * Usage:
 *   npm run review-history -- <owner/repo> [<pr number>] > history.jsonl
 *
 * Reads the GitHub token from `GITHUB_TOKEN`, or from `gh auth token` when that is unset.
 */

import { execFileSync } from 'child_process';
import * as github from '@actions/github';

import { extractReviewRecords, hasReviewRecord } from '../src/review-record';

interface ReviewLike {
  id: number;
  body?: string | null;
  user?: { login: string } | null;
  commit_id?: string | null;
  submitted_at?: string | null;
}

interface HistoryLine {
  repo: string;
  pr: number;
  reviewId: number;
  author?: string;
  commitId?: string;
  submittedAt?: string;
  record: unknown;
}

/** Returns one line per round record in `reviews`. A record that can't be decoded or parsed is reported on stderr and skipped. */
export function historyLines(repo: string, pr: number, reviews: ReviewLike[]): HistoryLine[] {
  const lines: HistoryLine[] = [];
  for (const review of reviews) {
    if (!review.body || !hasReviewRecord(review.body)) continue;
    const { records, errors } = extractReviewRecords(review.body);
    for (const error of errors) {
      console.error(`Skipping an undecodable record in review ${review.id} on ${repo}#${pr}: ${error}`);
    }
    for (const text of records) {
      let record: unknown;
      try {
        record = JSON.parse(text);
      } catch {
        console.error(`Skipping a record that is not JSON in review ${review.id} on ${repo}#${pr}`);
        continue;
      }
      lines.push({
        repo,
        pr,
        reviewId: review.id,
        ...(review.user?.login && { author: review.user.login }),
        ...(review.commit_id && { commitId: review.commit_id }),
        ...(review.submitted_at && { submittedAt: review.submitted_at }),
        record,
      });
    }
  }
  return lines;
}

function githubToken(): string {
  return process.env.GITHUB_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8' }).trim();
}

async function main(args: string[]): Promise<number> {
  const [fullName, prArg] = args;
  const [owner, repo] = fullName?.split('/') ?? [];
  const prNumber = prArg === undefined ? undefined : Number(prArg);
  if (!owner || !repo || (prNumber !== undefined && !Number.isInteger(prNumber))) {
    console.error('Usage: npm run review-history -- <owner/repo> [<pr number>]');
    return 1;
  }

  const octokit = github.getOctokit(githubToken());
  const prs = prNumber !== undefined
    ? [prNumber]
    : (await octokit.paginate(octokit.rest.pulls.list, { owner, repo, state: 'all', per_page: 100 })).map(p => p.number).sort((a, b) => a - b);
  for (const pr of prs) {
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: pr, per_page: 100 });
    for (const line of historyLines(fullName, pr, reviews)) {
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
