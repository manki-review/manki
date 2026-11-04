import { FindingFingerprint, FindingFingerprintEntry, ThreadEvaluation } from './types';

/**
 * Index `threadEvaluations` by `threadId` for O(1) lookup.
 *
 * The judge response carries one `ThreadEvaluation` per `OpenThread.threadId`.
 * Suppression and verdict logic look these up by the prior-round
 * `FindingFingerprintEntry.threadId`. A flat array would force a linear scan
 * per prior on every call, so callers build the index once and pass the map.
 */
export function indexThreadEvaluations(
  evaluations: ThreadEvaluation[] | undefined,
): Map<string, ThreadEvaluation> {
  const map = new Map<string, ThreadEvaluation>();
  if (!evaluations) return map;
  for (const e of evaluations) {
    map.set(e.threadId, e);
  }
  return map;
}

/**
 * Whether the judge's latest evaluation marks a prior-round thread as
 * addressed by the inter-round diff.
 *
 * `uncertain` and missing entries collapse to "not addressed" so the verdict
 * and cross-round suppression paths default to the safer outcome when the
 * judge could not produce a confident answer.
 *
 * A prior without a `threadId` has no thread to evaluate and is never
 * addressed here.
 */
export function isPriorAddressedByJudge(
  prior: FindingFingerprintEntry,
  threadEvaluationsByThreadId: Map<string, ThreadEvaluation>,
): boolean {
  if (!prior.threadId) return false;
  const evaluation = threadEvaluationsByThreadId.get(prior.threadId);
  return evaluation?.status === 'addressed';
}

/** How far a thread's posted line may sit from a prior's fingerprint lines and still match. */
const PRIOR_THREAD_LINE_TOLERANCE = 5;

/** A posted Manki thread, as far as matching it to a finding needs. */
interface PostedThread {
  threadId?: string;
  file: string;
  line: number;
  originalLine?: number;
  markerSlug?: string;
}

/**
 * Returns the ID of the thread posted for a finding: same file and marker slug, nearest
 * line within `PRIOR_THREAD_LINE_TOLERANCE`. A file-level thread matches any line.
 */
export function findPriorThreadId(fp: FindingFingerprint, threads: PostedThread[]): string | undefined {
  let best: { threadId: string; distance: number } | undefined;
  for (const t of threads) {
    if (t.file !== fp.file || t.markerSlug !== fp.slug) continue;
    const line = t.originalLine ?? t.line;
    // A file-level thread has no line, so it matches on file and slug alone, behind any line thread.
    const distance = !line
      ? PRIOR_THREAD_LINE_TOLERANCE
      : line < fp.lineStart ? fp.lineStart - line : Math.max(0, line - fp.lineEnd);
    if (distance > PRIOR_THREAD_LINE_TOLERANCE) continue;
    if (!best || distance < best.distance) best = { threadId: t.threadId!, distance };
  }
  return best?.threadId;
}
