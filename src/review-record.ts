import { gunzipSync, gzipSync } from 'zlib';

import type { ApprovalRecord, ReplyDecision, ReplyRecord, RoundContext } from './types';
import { COMMENT_MARKER, linesBelow, ownMarker, redactSecretsDeep, sanitizeHtmlCommentJson, sanitizeTokens } from './utils';

/** Opens a round record, plain or compressed. */
const RECORD_OPENER = '<!-- manki-context';
/** Larger than any real record, so a crafted compressed one can't exhaust memory. */
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

/**
 * Returns the round context as a hidden HTML comment: plain JSON when it fits in `room`
 * characters, otherwise gzip compressed and base64 encoded.
 */
export function formatReviewRecord(context: RoundContext, room: number = Infinity): string {
  const ctx = context.judge.threadEvaluations?.length === 0
    ? { ...context, judge: { ...context.judge, threadEvaluations: undefined } }
    : context;
  const json = recordJson(ctx);
  const plain = `<!-- manki-context: ${sanitizeHtmlCommentJson(json)} -->`;
  if (plain.length <= room) return plain;
  return `<!-- manki-context-gzip: ${gzipSync(json).toString('base64')} -->`;
}

/** Returns a reply-handler run's record as a hidden HTML comment. */
export function formatReplyRecord(record: ReplyRecord): string {
  return `<!-- manki-reply-record: ${sanitizeHtmlCommentJson(recordJson(record))} -->`;
}

/** Returns a review state check's approval decision as a hidden HTML comment. */
export function formatApprovalRecord(record: ApprovalRecord): string {
  return `<!-- manki-approval-record: ${sanitizeHtmlCommentJson(recordJson(record))} -->`;
}

/**
 * Returns the JSON text of the approval record in a review or comment body. Manki writes it last, so an earlier one is
 * quoted text. An approval review writes it below `COMMENT_MARKER`. A notice has no such line.
 */
export function extractApprovalRecords(body: string): string[] {
  const last = ownMarker(body, '<!-- manki-approval-record: ', COMMENT_MARKER);
  return last ? [last] : [];
}

/**
 * Returns the JSON text of the reply record in a comment body. Every reply writes it below `COMMENT_MARKER`, so a body
 * without that line holds none, and a record above the line is quoted text.
 */
export function extractReplyRecords(body: string): string[] {
  const last = body.includes(`\n${COMMENT_MARKER}`) ? ownMarker(body, '<!-- manki-reply-record: ', COMMENT_MARKER) : undefined;
  return last ? [last] : [];
}

/** What a reply record says happened to the thread when Manki accepted a reply of the PR author or of someone with write access. Any other value settles nothing. */
const SETTLING_FATES: ReadonlySet<string> = new Set(['resolves', 'already_resolved']);

/**
 * Returns the decision in the reply record of `body`, one of Manki's own thread replies, when that answer settled the
 * finding. A record that cannot be read, or one whose thread stayed open, settles nothing.
 */
export function settlingDecision(body: string): ReplyDecision | undefined {
  return settlingRecord(body)?.decision;
}

/** Returns the id of the developer's comment that the reply record of `body` answers, when that answer settled the finding. */
export function settledReplyId(body: string): number | undefined {
  const answers = settlingRecord(body)?.answers;
  return typeof answers === 'number' ? answers : undefined;
}

function settlingRecord(body: string): (Partial<ReplyRecord> & { decision: ReplyDecision }) | undefined {
  const [text] = extractReplyRecords(body);
  if (!text) return undefined;
  try {
    const record = JSON.parse(text) as Partial<ReplyRecord> | null;
    return record?.decision && SETTLING_FATES.has(record.decision.thread) ? { ...record, decision: record.decision } : undefined;
  } catch {
    return undefined;
  }
}

export const FIXED_MARKER_OPENER = '<!-- manki-fixed:';

/** Marks Manki's reply that confirms a fix on `commitSha`, so a thread gets one such reply per head. */
export function fixedMarker(commitSha: string): string {
  return `${FIXED_MARKER_OPENER}${commitSha} -->`;
}

/** Serializes a record with secrets and tokens redacted, since nothing that scans posted text can see inside a compressed one. */
function recordJson(record: object): string {
  return sanitizeTokens(JSON.stringify(redactSecretsDeep(record)));
}

/**
 * Returns `context` without its per-file and per-finding diagnostics, the units of the change and the finders' lines for
 * them, keeping what later rounds read:
 * the findings, thread evaluations, verdict and counts. With `keepTraces`, the raw findings keep their titles, locations,
 * severities and reviewers, and the uses outside the diff keep only names and locations, so a missed defect can still be
 * traced. `meta.omitted` names each field it left out, and `meta.compacted` each field it shortened.
 */
export function omitBulkyDiagnostics(context: RoundContext, keepTraces: boolean): RoundContext {
  const { perFile: _perFile, excludedFiles: _excludedFiles, binarySkipped: _binarySkipped, ...diff } = context.diff;
  const { rawFindings, ...reviewersWithLines } = context.reviewers;
  // The units of the change and each finder's lines for them are diagnostics too.
  const unitLines = reviewersWithLines.agentMetrics?.some(m => m.units) ? true : undefined;
  const reviewers = unitLines ? { ...reviewersWithLines, agentMetrics: reviewersWithLines.agentMetrics!.map(({ units: _units, ...metric }) => metric) } : reviewersWithLines;
  const { dropped: _dropped, ...judge } = context.judge;
  const { duplicateMatches: _duplicateMatches, staticSignalMatches: _staticSignalMatches, ...dedup } = context.dedup;
  const uses = context.usesOutsideDiff;
  const traces: Array<[string, unknown]> = [['reviewers.rawFindings', rawFindings], ['usesOutsideDiff', uses]];
  const present: Array<[string, unknown]> = [
    ['diff.perFile', context.diff.perFile], ['diff.excludedFiles', context.diff.excludedFiles], ['diff.binarySkipped', context.diff.binarySkipped],
    ['judge.dropped', context.judge.dropped],
    ['dedup.duplicateMatches', context.dedup.duplicateMatches], ['dedup.staticSignalMatches', context.dedup.staticSignalMatches],
    ['recap.reclassifiedPriors', context.recap?.reclassifiedPriors],
    ['units', context.units], ['reviewers.agentMetrics.units', unitLines],
    ...(keepTraces ? [] : traces),
  ];
  const named = (fields: Array<[string, unknown]>) => fields.filter(([, value]) => value !== undefined).map(([field]) => field);
  const compacted = keepTraces ? named(traces) : [];
  return {
    ...context,
    units: undefined,
    usesOutsideDiff: keepTraces && uses ? { ...uses, ...(uses.types && { types: uses.types.map(t => t.match(/^(.+?:\d+):/)?.[1] ?? t) }) } : undefined,
    meta: { ...context.meta, omitted: named(present), ...(compacted.length > 0 && { compacted }) },
    diff,
    reviewers: keepTraces && rawFindings
      ? { ...reviewers, rawFindings: rawFindings.map(({ title, file, line, severity, reviewers: by }) => ({ title, file, line, severity, reviewers: by })) }
      : reviewers,
    judge,
    dedup,
    ...(context.recap && { recap: { ...context.recap, reclassifiedPriors: undefined } }),
  };
}

/** Whether `body` carries a round record. */
export function hasReviewRecord(body: string): boolean {
  return ownMarker(body, RECORD_OPENER) !== undefined;
}

/**
 * Whether Manki itself wrote the flag `marker` in `body`: on a line of its own below the last line that starts with
 * `anchor`, or anywhere when no line does. The text above the anchor quotes code and model text, which can hold a
 * marker. The anchor is the round record in a review body and `COMMENT_MARKER` in a thread reply.
 */
export function hasOwnMarker(body: string, marker: string, anchor = RECORD_OPENER): boolean {
  return linesBelow(body, anchor).some(l => l.trimEnd() === marker);
}

/**
 * Returns the JSON text of the round record in a review body, decompressed when needed, or the
 * error when it can't be decoded. Manki writes the record last, so only the last record
 * counts: an earlier one is quoted text.
 */
export function extractReviewRecords(body: string): { records: string[]; errors: string[] } {
  const last = ownMarker(body, RECORD_OPENER);
  if (last === undefined) return { records: [], errors: [] };
  if (last.startsWith(': ')) return { records: [last.slice(2)], errors: [] };
  try {
    if (!/^-gzip: [A-Za-z0-9+/=]+$/.test(last)) throw new Error('not a round record');
    return { records: [gunzipSync(Buffer.from(last.slice('-gzip: '.length), 'base64'), { maxOutputLength: MAX_RECORD_BYTES }).toString('utf-8')], errors: [] };
  } catch (error) {
    return { records: [], errors: [error instanceof Error ? error.message : String(error)] };
  }
}
