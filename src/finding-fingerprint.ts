import { FindingFingerprintEntry, ThreadEvaluation } from './types';

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
 * Only callable for priors that carry a `threadId`. Priors from older
 * handover formats without a `threadId` cannot be matched to a judge
 * evaluation and must be handled by the caller (typically by treating them
 * as still unresolved).
 */
export function isPriorAddressedByJudge(
  prior: FindingFingerprintEntry,
  threadEvaluationsByThreadId: Map<string, ThreadEvaluation>,
): boolean {
  if (!prior.threadId) return false;
  const evaluation = threadEvaluationsByThreadId.get(prior.threadId);
  return evaluation?.status === 'addressed';
}
