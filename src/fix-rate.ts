import * as core from '@actions/core';
import * as github from '@actions/github';

import { parsePRDiff } from './diff';
import { BotIdentity, fetchInterRoundDiff } from './github';
import { appendMemoryLine, MemoryStore } from './memory';
import { classifyAuthorReply, fetchRecapState, judgeAddressedThreadIds, PreviousFinding } from './recap';
import { citesEvidence, FindingFingerprint, FindingFingerprintEntry, ParsedDiff, RoundContext } from './types';
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

interface OutcomeCounts extends Record<Outcome, number> {
  posted: number;
}

interface SpecialistKey {
  severity: string;
  specialist: string;
}

interface CalibrationKey {
  severity: string;
  /** How the finding was checked, its `checkStatus`. */
  checkStatus: string;
  toolEvidence: string;
  category: string;
  effort: string;
  /** Whether the finding cited evidence, which its comment or review body entry shows in the fold under it. */
  hadEvidence: boolean;
  /** Whether the judge tried to refute the finding with the repository tools. */
  judgeChecked: boolean;
}

export interface PostedFinding {
  entry: FindingFingerprintEntry;
  commitSha: string;
}

/**
 * Records how many posted findings of a merged pull request were fixed, dismissed or left
 * untouched, per severity and specialist (`counts`) and per severity, check status, tool
 * evidence, category, effort, whether the finding had evidence and whether the judge checked
 * it (`calibration`). Writes one JSON line to the job summary, and appends it to
 * `metrics/fix-rate.jsonl` in the repo's memory when `memory` is given. The line carries
 * the class, group and config digest of the last round that recorded them.
 */
export async function recordFixRate(
  octokit: Octokit,
  bot: BotIdentity,
  owner: string,
  repo: string,
  pr: MergedPullRequest,
  memory?: MemoryStore,
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
  const counts = new Map<string, SpecialistKey & OutcomeCounts>();
  const calibration = new Map<string, CalibrationKey & OutcomeCounts>();
  for (const { entry, commitSha } of posted) {
    const thread = entry.threadId ? threads.get(entry.threadId) : undefined;
    const fixed = (entry.threadId !== undefined && addressed.has(entry.threadId))
      || touchesFinding(diffs.get(commitSha), entry.fingerprint);
    const outcome: Outcome = fixed ? 'fixed' : isDismissed(thread, pr.authorLogin) ? 'dismissed' : 'untouched';
    const specialist = entry.reviewers?.[0] ?? entry.specialist ?? 'unknown';
    tally<SpecialistKey>(counts, { severity: entry.severity, specialist }, outcome);
    tally<CalibrationKey>(calibration, {
      severity: entry.severity,
      checkStatus: entry.checkStatus ?? 'unknown',
      toolEvidence: entry.toolEvidence ?? 'unknown',
      category: entry.category ?? 'unknown',
      effort: entry.effort ?? 'unknown',
      hadEvidence: citesEvidence(entry.evidence),
      judgeChecked: !!(entry.refutation ?? entry.pairRefutation),
    }, outcome);
  }

  const routing = [...priorRounds].reverse().find(r => r.routing)?.routing;
  const record = {
    pr: pr.number,
    mergedSha: pr.mergedSha,
    rounds: priorRounds.length,
    ...(routing && { class: routing.class ?? null, group: routing.group, configDigest: routing.configDigest }),
    counts: [...counts.values()],
    calibration: [...calibration.values()],
    ...(partial && { partial: true }),
  };
  const line = JSON.stringify(record);
  core.info(`Fix rate: ${line}`);

  try {
    await core.summary.addHeading('Manki fix rate', 3).addCodeBlock(line, 'json').write();
  } catch (error) {
    core.warning(`Failed to write the fix rate to the job summary: ${error}`);
  }

  if (!memory) return;
  try {
    await appendMemoryLine(memory, FIX_RATE_FILE, record, `Record fix rate of ${owner}/${repo}#${pr.number}`);
  } catch (error) {
    core.warning(`Failed to append the fix rate to ${memory.name}: ${sanitizeTokens(String(error))}`);
  }
}

function tally<K extends object>(rows: Map<string, K & OutcomeCounts>, dims: K, outcome: Outcome): void {
  const key = Object.values(dims).join('\n');
  const row = rows.get(key) ?? { ...dims, posted: 0, fixed: 0, dismissed: 0, untouched: 0 };
  row.posted++;
  row[outcome]++;
  rows.set(key, row);
}

/** A finding raised again in a later round counts once, measured from the latest round that raised it. */
export function postedFindings(rounds: RoundContext[]): PostedFinding[] {
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
export function touchesFinding(diff: ParsedDiff | undefined, fp: FindingFingerprint): boolean {
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
