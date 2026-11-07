import * as core from '@actions/core';
import * as github from '@actions/github';

import { truncateBody } from './github';
import type { ApprovalHeld } from './github';
import type { RoundOutcome } from './types';

type Octokit = ReturnType<typeof github.getOctokit>;

type CheckConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'action_required';

/** How a `Manki` check run ends, and the title and summary it shows on the PR. */
export interface CheckReport {
  conclusion: CheckConclusion;
  title: string;
  summary: string;
}

/** A `Manki` check run this run created on the PR head. */
export interface ReviewCheck {
  octokit: Octokit;
  owner: string;
  repo: string;
  id: number;
}

const CHECK_NAME = 'Manki';
const CHECK_STATE_KEY = 'manki_check_run';

const OUTCOME_REPORTS: Record<RoundOutcome, Omit<CheckReport, 'summary'>> = {
  READY: { conclusion: 'success', title: 'Approved' },
  ADDRESS_FIRST: { conclusion: 'failure', title: 'Changes requested' },
  NOT_CONVERGING: { conclusion: 'failure', title: 'Needs a human' },
  INCOMPLETE: { conclusion: 'failure', title: 'Review incomplete' },
};

const HELD_TITLES: Record<Exclude<ApprovalHeld, false>, string> = {
  conflict: 'Approval held: the PR conflicts with its base',
  draft: 'Approval held: the PR is a draft',
};

/** Returns the check report for a round that ended with `outcome`. A held approval reports neutral, whatever the outcome. */
export function outcomeReport(outcome: RoundOutcome, summary: string, approvalHeld: ApprovalHeld = false): CheckReport {
  if (approvalHeld) return { conclusion: 'neutral', title: HELD_TITLES[approvalHeld], summary };
  return { ...OUTCOME_REPORTS[outcome], summary };
}

/** Returns the check report for a run that failed. A failure keeps a required check blocking. */
export function failedReport(summary: string): CheckReport {
  return { conclusion: 'failure', title: 'Review failed', summary };
}

/**
 * Creates an in-progress `Manki` check run on `headSha` that links to this run. The run itself belongs to the
 * default branch and so shows on no PR. A failure is logged and returns `undefined`.
 */
export async function startReviewCheck(octokit: Octokit, owner: string, repo: string, headSha: string): Promise<ReviewCheck | undefined> {
  const { serverUrl, runId } = github.context;
  try {
    const { data } = await octokit.rest.checks.create({
      owner,
      repo,
      name: CHECK_NAME,
      head_sha: headSha,
      status: 'in_progress',
      details_url: `${serverUrl}/${owner}/${repo}/actions/runs/${runId}`,
    });
    core.saveState(CHECK_STATE_KEY, String(data.id));
    return { octokit, owner, repo, id: data.id };
  } catch (error) {
    core.warning(`Could not create the ${CHECK_NAME} check, reviewing without it. The GitHub App needs the Checks read and write permission: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

/** Completes `check` with `report`. A failure is logged and leaves the check in progress for the post step to cancel. */
export async function completeReviewCheck(check: ReviewCheck | undefined, { conclusion, title, summary }: CheckReport): Promise<void> {
  if (!check) return;
  const { octokit, owner, repo, id } = check;
  try {
    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: id,
      status: 'completed',
      conclusion,
      output: { title, summary: truncateBody(summary.trim() || title) },
    });
  } catch (error) {
    core.warning(`Could not complete the ${CHECK_NAME} check: ${error instanceof Error ? error.message : error}`);
  }
}

/** Completes as cancelled the check run the main step left in progress. Runs in the post step, after a cancel or a failure. */
export async function cancelOpenReviewCheck(octokit: Octokit, owner: string, repo: string): Promise<void> {
  const id = Number(core.getState(CHECK_STATE_KEY));
  if (!id) return;
  try {
    const { data } = await octokit.rest.checks.get({ owner, repo, check_run_id: id });
    if (data.status === 'completed') return;
  } catch (error) {
    core.warning(`Could not read the ${CHECK_NAME} check: ${error instanceof Error ? error.message : error}`);
    return;
  }
  await completeReviewCheck({ octokit, owner, repo, id }, {
    conclusion: 'cancelled',
    title: 'Review stopped',
    summary: 'The run ended before the review finished.',
  });
}
