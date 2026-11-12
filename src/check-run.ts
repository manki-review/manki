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

/** A `Manki` check run this run created or took over on commit `headSha`. */
export interface ReviewCheck {
  octokit: Octokit;
  owner: string;
  repo: string;
  id: number;
  headSha: string;
}

/** A queued `Manki` check run the token service created for this run's review, on commit `headSha`. */
export interface QueuedCheck {
  id: number;
  headSha: string;
}

const CHECK_NAME = 'Manki';
const CHECK_STATE_KEY = 'manki_check_run';

const queuedChecks = new WeakMap<Octokit, QueuedCheck>();

/** Records the queued check the token service created for the run of `octokit`, for `startReviewCheck` to take over. */
export function offerQueuedCheck(octokit: Octokit, check: QueuedCheck): void {
  queuedChecks.set(octokit, check);
}

const OUTCOME_REPORTS: Record<RoundOutcome, Omit<CheckReport, 'summary'>> = {
  READY: { conclusion: 'success', title: 'Approved' },
  ADDRESS_FIRST: { conclusion: 'failure', title: 'Changes requested' },
  NOT_CONVERGING: { conclusion: 'failure', title: 'Needs a human' },
  INCOMPLETE: { conclusion: 'failure', title: 'Review incomplete' },
};

const HELD_TITLES: Record<Exclude<ApprovalHeld, false>, string> = {
  conflict: 'Approval held: the PR conflicts with its base',
  draft: 'Approval held: the PR is a draft',
  config: 'Approval held: a config file did not load',
  unread: 'Approval held: some changed files were not read',
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

/** The page of this run, which a `Manki` check links to. */
function runUrl(owner: string, repo: string): string {
  const { serverUrl, runId } = github.context;
  return `${serverUrl}/${owner}/${repo}/actions/runs/${runId}`;
}

/** Sets the queued check `id` in progress with a link to this run. A failure is logged and returns false. */
async function takeOverCheck(octokit: Octokit, owner: string, repo: string, id: number, detailsUrl: string): Promise<boolean> {
  try {
    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: id,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      details_url: detailsUrl,
      output: { title: 'Review in progress', summary: 'The review run is linked from this check.' },
    });
    return true;
  } catch (error) {
    core.warning(`Could not take over the queued ${CHECK_NAME} check, creating a new one: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

/**
 * Shows an in-progress `Manki` check run on `headSha` that links to this run. The run itself belongs to the default
 * branch and so shows on no PR. It takes over the queued check the token service created on `headSha`, and creates
 * one without it. A failure is logged and returns `undefined`.
 */
export async function startReviewCheck(octokit: Octokit, owner: string, repo: string, headSha: string): Promise<ReviewCheck | undefined> {
  const detailsUrl = runUrl(owner, repo);
  const queued = queuedChecks.get(octokit);
  queuedChecks.delete(octokit);
  try {
    const id = queued?.headSha === headSha && await takeOverCheck(octokit, owner, repo, queued.id, detailsUrl)
      ? queued.id
      : (await octokit.rest.checks.create({ owner, repo, name: CHECK_NAME, head_sha: headSha, status: 'in_progress', details_url: detailsUrl })).data.id;
    core.saveState(CHECK_STATE_KEY, String(id));
    return { octokit, owner, repo, id, headSha };
  } catch (error) {
    core.warning(`Could not create the ${CHECK_NAME} check, reviewing without it. The GitHub App needs the Checks read and write permission: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

/** The conclusions that let a required check pass. Every other conclusion blocks the merge, as a check that has not completed does. */
const PASSING: ReadonlySet<CheckConclusion> = new Set<CheckConclusion>(['success', 'neutral', 'skipped']);

/** The App's other `Manki` checks on a commit: none, all `completed`, at least one `running`, or `unknown`. `why` says it in words. */
type OtherChecks = { state: 'none' } | { state: 'completed' | 'running' | 'unknown'; why: string };

/**
 * Reads the other `Manki` checks of the App `appId` on the commit of `check`. The list counts only when it is
 * whole and names `check`. Everything else is `unknown`.
 */
async function otherChecks(check: ReviewCheck, appId: number | undefined): Promise<OtherChecks> {
  if (appId === undefined) return { state: 'unknown', why: 'the App that owns this run\'s check is unknown' };
  const { octokit, owner, repo, id, headSha } = check;
  try {
    const { data } = await octokit.rest.checks.listForRef({ owner, repo, ref: headSha, check_name: CHECK_NAME, app_id: appId, filter: 'all', per_page: 100 });
    const others = data.check_runs.filter(run => run.id !== id);
    if (data.total_count !== data.check_runs.length || others.length === data.check_runs.length) {
      return { state: 'unknown', why: `the list of ${CHECK_NAME} checks on ${headSha} is not whole` };
    }
    if (others.length === 0) return { state: 'none' };
    return others.every(run => run.status === 'completed')
      ? { state: 'completed', why: `this run's check is not the only ${CHECK_NAME} check of the App on ${headSha}` }
      : { state: 'running', why: `another ${CHECK_NAME} check of the App on ${headSha} has not completed` };
  } catch (error) {
    return { state: 'unknown', why: `the ${CHECK_NAME} checks on ${headSha} could not be listed (${error instanceof Error ? error.message : error})` };
  }
}

/**
 * Completes `check` with `report`. A failure is logged and leaves the check in progress for the post step to cancel.
 * GitHub reads the `Manki` check created last on a commit, so beside another check of the App a new check carries
 * the result as well. A passing result would hide a review that still runs, so it needs every other check completed.
 */
export async function completeReviewCheck(check: ReviewCheck | undefined, { conclusion, title, summary }: CheckReport): Promise<void> {
  if (!check) return;
  const { octokit, owner, repo, id, headSha } = check;
  const result = { status: 'completed' as const, conclusion, output: { title, summary: truncateBody(summary.trim() || title) } };
  let appId: number | undefined;
  try {
    const { data } = await octokit.rest.checks.update({ owner, repo, check_run_id: id, ...result });
    appId = data.app?.id;
  } catch (error) {
    core.warning(`Could not complete the ${CHECK_NAME} check: ${error instanceof Error ? error.message : error}`);
  }
  // A cancelled run reached no verdict, so a newer check keeps speaking for the commit.
  if (conclusion === 'cancelled') return;
  const others = await otherChecks(check, appId);
  if (others.state === 'none') return;
  if (PASSING.has(conclusion) && others.state !== 'completed') {
    core.info(`No new ${CHECK_NAME} check for "${title}", since ${others.why}`);
    return;
  }
  try {
    await octokit.rest.checks.create({ owner, repo, name: CHECK_NAME, head_sha: headSha, details_url: runUrl(owner, repo), ...result });
    core.info(`Wrote "${title}" into a new ${CHECK_NAME} check as well, since ${others.why}`);
  } catch (error) {
    core.warning(`Could not write "${title}" into a new ${CHECK_NAME} check: ${error instanceof Error ? error.message : error}`);
  }
}

/** Completes as cancelled the check run the main step left in progress. Runs in the post step, after a cancel or a failure. */
export async function cancelOpenReviewCheck(octokit: Octokit, owner: string, repo: string): Promise<void> {
  const id = Number(core.getState(CHECK_STATE_KEY));
  if (!id) return;
  let headSha: string;
  try {
    const { data } = await octokit.rest.checks.get({ owner, repo, check_run_id: id });
    if (data.status === 'completed') return;
    headSha = data.head_sha;
  } catch (error) {
    core.warning(`Could not read the ${CHECK_NAME} check: ${error instanceof Error ? error.message : error}`);
    return;
  }
  await completeReviewCheck({ octokit, owner, repo, id, headSha }, {
    conclusion: 'cancelled',
    title: 'Review stopped',
    summary: 'The run ended before the review finished.',
  });
}
