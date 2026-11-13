import * as core from '@actions/core';
import * as github from '@actions/github';

import { assertWritesAllowed } from './abort';
import { BOT_LOGIN, isBotLogin, truncateBody } from './github';
import type { ApprovalHeld, BotIdentity } from './github';
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

/** A queued `Manki` check run the token service created for this run's review, on commit `headSha`. */
export interface QueuedCheck {
  id: number;
  headSha: string;
}

const CHECK_NAME = 'Manki';
const CHECK_STATE_KEY = 'manki_check_run';
/** How long a failed completion waits before its one retry. */
const COMPLETE_RETRY_MS = 3_000;

const queuedChecks = new WeakMap<Octokit, QueuedCheck>();

/** Records the queued check the token service created for the run of `octokit`, for `startReviewCheck` to take over. */
export function offerQueuedCheck(octokit: Octokit, check: QueuedCheck): void {
  queuedChecks.set(octokit, check);
}

/** Takes the queued check offered for the run of `octokit` when it sits on `headSha`. A check is offered once, whatever its head. */
function takeQueuedCheck(octokit: Octokit, headSha: string): QueuedCheck | undefined {
  const queued = queuedChecks.get(octokit);
  queuedChecks.delete(octokit);
  return queued?.headSha === headSha ? queued : undefined;
}

/** The link from a check to this run. */
function runUrl(owner: string, repo: string): string {
  const { serverUrl, runId } = github.context;
  return `${serverUrl}/${owner}/${repo}/actions/runs/${runId}`;
}

function checkOutput({ title, summary }: CheckReport): { title: string; summary: string } {
  return { title, summary: truncateBody(summary.trim() || title) };
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
  warnings: 'Approval held: warnings wait for a fix or an answer',
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
 * one without it. A failure is logged and returns `undefined`. Throws once the run is cancelled, before any write.
 */
export async function startReviewCheck(octokit: Octokit, owner: string, repo: string, headSha: string): Promise<ReviewCheck | undefined> {
  assertWritesAllowed();
  const detailsUrl = runUrl(owner, repo);
  const queued = takeQueuedCheck(octokit, headSha);
  try {
    const id = queued && await takeOverCheck(octokit, owner, repo, queued.id, detailsUrl)
      ? queued.id
      : (await octokit.rest.checks.create({ owner, repo, name: CHECK_NAME, head_sha: headSha, status: 'in_progress', details_url: detailsUrl })).data.id;
    core.saveState(CHECK_STATE_KEY, String(id));
    return { octokit, owner, repo, id };
  } catch (error) {
    core.warning(`Could not create the ${CHECK_NAME} check, reviewing without it. The GitHub App needs the Checks read and write permission: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

/**
 * Completes `check` with `report`, trying once more after `COMPLETE_RETRY_MS`. A second failure, or a run cancelled
 * meanwhile, is logged and leaves the check in progress for the post step to cancel.
 */
export async function completeReviewCheck(check: ReviewCheck | undefined, report: CheckReport): Promise<void> {
  if (!check) return;
  const { octokit, owner, repo, id } = check;
  const complete = () => {
    assertWritesAllowed();
    return octokit.rest.checks.update({ owner, repo, check_run_id: id, status: 'completed', conclusion: report.conclusion, output: checkOutput(report) });
  };
  try {
    await complete().catch(async () => {
      await new Promise(resolve => setTimeout(resolve, COMPLETE_RETRY_MS));
      return complete();
    });
  } catch (error) {
    core.warning(`Could not complete the ${CHECK_NAME} check: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Reports `report` on `headSha` in a check that is completed in one call, for a run that has nothing to show in progress.
 * It completes the queued check the token service created on `headSha`, and creates one without it. A failure is logged.
 * Throws once the run is cancelled, before its next write.
 */
export async function reportCheck(octokit: Octokit, owner: string, repo: string, headSha: string, report: CheckReport): Promise<void> {
  assertWritesAllowed();
  const completed = { status: 'completed' as const, conclusion: report.conclusion, details_url: runUrl(owner, repo), output: checkOutput(report) };
  const queued = takeQueuedCheck(octokit, headSha);
  const completeQueued = (id: number) => octokit.rest.checks.update({ owner, repo, check_run_id: id, ...completed });
  try {
    if (queued) {
      try {
        await completeQueued(queued.id);
        return;
      } catch (error) {
        core.warning(`Could not complete the queued ${CHECK_NAME} check, creating a new one: ${error instanceof Error ? error.message : error}`);
      }
    }
    assertWritesAllowed();
    await octokit.rest.checks.create({ owner, repo, name: CHECK_NAME, head_sha: headSha, ...completed });
    // The queued check would otherwise stay queued until the token service ends it.
    if (queued) {
      assertWritesAllowed();
      await completeQueued(queued.id).catch(error => {
        core.warning(`Could not complete the queued ${CHECK_NAME} check: ${error instanceof Error ? error.message : error}`);
      });
    }
  } catch (error) {
    assertWritesAllowed();
    core.warning(`Could not report the ${CHECK_NAME} check. The GitHub App needs the Checks read and write permission: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Whether the newest `Manki` check on `headSha` passed, counting the checks of `bot`'s App and of the Manki App. Those are
 * the checks branch protection reads: the run writes with `bot`, and the Manki service writes the waiting checks. A failed
 * read counts as no, so the caller reports again.
 */
export async function newestCheckPassed(octokit: Octokit, bot: BotIdentity, owner: string, repo: string, headSha: string): Promise<boolean> {
  try {
    const runs = await octokit.paginate(octokit.rest.checks.listForRef, { owner, repo, ref: headSha, check_name: CHECK_NAME, filter: 'all', per_page: 100 });
    const newest = runs
      .filter(run => isBotLogin(bot, run.app?.slug) || isBotLogin({ logins: [BOT_LOGIN] }, run.app?.slug))
      .reduce<typeof runs[number] | undefined>((last, run) => (!last || run.id > last.id ? run : last), undefined);
    return newest?.status === 'completed' && newest.conclusion === 'success';
  } catch (error) {
    core.warning(`Could not read the ${CHECK_NAME} checks of ${headSha.slice(0, 7)}: ${error instanceof Error ? error.message : error}`);
    return false;
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
