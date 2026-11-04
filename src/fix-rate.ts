import * as core from '@actions/core';
import * as github from '@actions/github';

import { parsePRDiff } from './diff';
import { BotIdentity, fetchInterRoundDiff } from './github';
import { appendMemoryLine } from './memory';
import { classifyAuthorReply, fetchRecapState, judgeAddressedThreadIds, PreviousFinding } from './recap';
import { FindingFingerprint, FindingFingerprintEntry, ParsedDiff, RoundContext } from './types';
import { sanitizeTokens } from './utils';

type Octokit = ReturnType<typeof github.getOctokit>;

const FIX_RATE_FILE = 'metrics/fix-rate.jsonl';

export interface MergedPullRequest {
  number: number;
  headSha: string;
  mergedSha: string;
  authorLogin?: string;
}

type Outcome = 'fixed' | 'dismissed' | 'untouched';

interface FixRateCounts extends Record<Outcome, number> {
  severity: string;
  specialist: string;
  posted: number;
}

interface PostedFinding {
  entry: FindingFingerprintEntry;
  commitSha: string;
}

/**
 * Records how many posted findings of a merged pull request were fixed, dismissed or left
 * untouched, per severity and specialist. Writes one JSON line to the job summary, and
 * appends it to `<repo>/metrics/fix-rate.jsonl` in the memory repo when `memory` is given.
 */
export async function recordFixRate(
  octokit: Octokit,
  bot: BotIdentity,
  owner: string,
  repo: string,
  pr: MergedPullRequest,
  memory?: { octokit: Octokit; repo: string },
): Promise<void> {
  const { previousFindings, priorRounds } = await fetchRecapState(octokit, bot, owner, repo, pr.number, pr.authorLogin);
  if (priorRounds.length === 0) {
    core.info('No Manki review rounds on this pull request, no fix rate to record');
    return;
  }

  const posted = postedFindings(priorRounds);
  const diffs = new Map<string, ParsedDiff>();
  let partial = false;
  // Compared with the head, not the merge commit: after a squash merge the compare base would fall back to the fork point.
  for (const sha of new Set(posted.map(p => p.commitSha))) {
    try {
      diffs.set(sha, parsePRDiff(await fetchInterRoundDiff(octokit, owner, repo, sha, pr.headSha)));
    } catch (error) {
      partial = true;
      core.warning(`Failed to compare ${sha.slice(0, 7)} with ${pr.headSha.slice(0, 7)}, code changes since that round are not counted: ${error}`);
    }
  }

  const addressed = judgeAddressedThreadIds(priorRounds);
  const threads = new Map(previousFindings.filter(f => f.threadId).map(f => [f.threadId as string, f]));
  const counts = new Map<string, FixRateCounts>();
  for (const { entry, commitSha } of posted) {
    const specialist = entry.reviewers?.[0] ?? entry.specialist ?? 'unknown';
    const key = `${entry.severity}\n${specialist}`;
    const row = counts.get(key) ?? { severity: entry.severity, specialist, posted: 0, fixed: 0, dismissed: 0, untouched: 0 };
    row.posted++;
    const thread = entry.threadId ? threads.get(entry.threadId) : undefined;
    const fixed = (entry.threadId !== undefined && addressed.has(entry.threadId))
      || touchesFinding(diffs.get(commitSha), entry.fingerprint);
    row[fixed ? 'fixed' : isDismissed(thread, pr.authorLogin) ? 'dismissed' : 'untouched']++;
    counts.set(key, row);
  }

  const line = JSON.stringify({
    pr: pr.number,
    mergedSha: pr.mergedSha,
    rounds: priorRounds.length,
    counts: [...counts.values()],
    ...(partial && { partial: true }),
  });
  core.info(`Fix rate: ${line}`);

  try {
    await core.summary.addHeading('Manki fix rate', 3).addCodeBlock(line, 'json').write();
  } catch (error) {
    core.warning(`Failed to write the fix rate to the job summary: ${error}`);
  }

  if (!memory) return;
  try {
    await appendMemoryLine(memory.octokit, memory.repo, repo, FIX_RATE_FILE, line, `Record fix rate of ${owner}/${repo}#${pr.number}`);
  } catch (error) {
    core.warning(`Failed to append the fix rate to ${memory.repo}: ${sanitizeTokens(String(error))}`);
  }
}

/** A finding raised again in a later round counts once, measured from the latest round that raised it. */
function postedFindings(rounds: RoundContext[]): PostedFinding[] {
  const byKey = new Map<string, PostedFinding>();
  for (const round of rounds) {
    for (const entry of round.findings.entries) {
      const key = `${entry.fingerprint.file}\n${entry.fingerprint.slug}`;
      const threadId = entry.threadId ?? byKey.get(key)?.entry.threadId;
      byKey.set(key, { entry: threadId ? { ...entry, threadId } : entry, commitSha: round.meta.commitSha });
    }
  }
  return [...byKey.values()];
}

/** Whether the diff changed the finding's lines. Hunks include the unchanged lines around each change, which act as the line window. */
function touchesFinding(diff: ParsedDiff | undefined, fp: FindingFingerprint): boolean {
  const file = diff?.files.find(f => (f.oldPath ?? f.path) === fp.file);
  if (!file) return false;
  if (fp.lineStart <= 0) return file.hunks.length > 0;
  return file.hunks.some(h => h.oldStart <= fp.lineEnd && h.oldStart + Math.max(h.oldLines, 1) - 1 >= fp.lineStart);
}

function isDismissed(thread: PreviousFinding | undefined, prAuthorLogin: string | undefined): boolean {
  if (!thread) return false;
  if (thread.status === 'resolved') return true;
  return prAuthorLogin !== undefined
    && thread.authorReplyLogin === prAuthorLogin
    && classifyAuthorReply(thread.authorReplyText) === 'agree';
}
