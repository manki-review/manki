import { createHash } from 'crypto';

import { CitedLine, FindingFingerprint, FindingFingerprintEntry, ThreadEvaluation } from './types';

/** Returns, per line of a file, a hash of the line with the line before and the line after it, each without the whitespace around it. */
function placeHashes(lines: string[]): string[] {
  const trimmed = lines.map(line => line.trim());
  return trimmed.map((_, i) => createHash('sha256').update(trimmed.slice(Math.max(0, i - 1), i + 2).join('\n')).digest('hex').slice(0, 12));
}

/** Returns the lines, counted from 1, of a file with `lines` that read like the place `hash` was taken from. */
export function placesReading(lines: string[], hash: string): number[] {
  return placeHashes(lines).flatMap((h, i) => h === hash ? [i + 1] : []);
}

/** Returns the `CitedLine` of `line`, counted from 1, in a file with `lines`, or undefined when the file has no such line. */
export function citedLine(lines: string[] | undefined, line: number): CitedLine | undefined {
  const hashes = placeHashes(lines ?? []);
  const hash = hashes[line - 1];
  return hash === undefined ? undefined : { hash, count: hashes.filter(h => h === hash).length };
}

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
  /** Line the finding names, which differs from the posted line when the finding was posted on a fallback line. */
  findingLine?: number;
  markerSlug?: string;
}

/**
 * Returns the ID of the thread posted for a finding: same file and marker slug, nearest
 * line within `PRIOR_THREAD_LINE_TOLERANCE`. A file-level thread matches any line. The line is the one the finding
 * names, which a thread posted on a fallback line still records, so such a thread matches too.
 */
export function findPriorThreadId(fp: FindingFingerprint, threads: PostedThread[]): string | undefined {
  let best: { threadId: string; distance: number } | undefined;
  for (const t of threads) {
    if (t.file !== fp.file || t.markerSlug !== fp.slug) continue;
    const line = t.findingLine ?? t.originalLine ?? t.line;
    // A file-level thread has no line, so it matches on file and slug alone, behind any line thread.
    const distance = !line
      ? PRIOR_THREAD_LINE_TOLERANCE
      : line < fp.lineStart ? fp.lineStart - line : Math.max(0, line - fp.lineEnd);
    if (distance > PRIOR_THREAD_LINE_TOLERANCE) continue;
    if (!best || distance < best.distance) best = { threadId: t.threadId!, distance };
  }
  return best?.threadId;
}
