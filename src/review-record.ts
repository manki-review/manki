import { gunzipSync, gzipSync } from 'zlib';

import type { ApprovalRecord, ReplyRecord, RoundContext } from './types';
import { redactSecretsDeep, sanitizeHtmlCommentJson, sanitizeTokens } from './utils';

const PLAIN_RE = /<!-- manki-context: ([\s\S]+?) -->/g;
const GZIP_RE = /<!-- manki-context-gzip: ([A-Za-z0-9+/=]+) -->/g;
const REPLY_RE = /<!-- manki-reply-record: ([\s\S]+?) -->/g;
const APPROVAL_RE = /<!-- manki-approval-record: ([\s\S]+?) -->/g;
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

/** Returns the JSON text of the approval record in a review or comment body. Manki writes it last, so an earlier one is quoted text. */
export function extractApprovalRecords(body: string): string[] {
  const last = [...body.matchAll(APPROVAL_RE)].at(-1);
  return last ? [last[1]] : [];
}

/** Returns the JSON text of the reply record in a comment body. Manki writes it last, so an earlier one is quoted text. */
export function extractReplyRecords(body: string): string[] {
  const last = [...body.matchAll(REPLY_RE)].at(-1);
  return last ? [last[1]] : [];
}

/** Serializes a record with secrets and tokens redacted, since nothing that scans posted text can see inside a compressed one. */
function recordJson(record: object): string {
  return sanitizeTokens(JSON.stringify(redactSecretsDeep(record)));
}

/**
 * Returns `context` without its per-file and per-finding diagnostics, keeping what later rounds read:
 * the findings, thread evaluations, verdict and counts. `meta.omitted` names each field it left out.
 */
export function omitBulkyDiagnostics(context: RoundContext): RoundContext {
  const { perFile: _perFile, excludedFiles: _excludedFiles, binarySkipped: _binarySkipped, ...diff } = context.diff;
  const { rawFindings: _rawFindings, ...reviewers } = context.reviewers;
  const { dropped: _dropped, ...judge } = context.judge;
  const { duplicateMatches: _duplicateMatches, staticSignalMatches: _staticSignalMatches, ...dedup } = context.dedup;
  const present: Array<[string, unknown]> = [
    ['diff.perFile', context.diff.perFile], ['diff.excludedFiles', context.diff.excludedFiles], ['diff.binarySkipped', context.diff.binarySkipped],
    ['reviewers.rawFindings', context.reviewers.rawFindings], ['judge.dropped', context.judge.dropped],
    ['dedup.duplicateMatches', context.dedup.duplicateMatches], ['dedup.staticSignalMatches', context.dedup.staticSignalMatches],
    ['recap.reclassifiedPriors', context.recap?.reclassifiedPriors],
    ['usesOutsideDiff', context.usesOutsideDiff],
  ];
  return {
    ...context,
    usesOutsideDiff: undefined,
    meta: { ...context.meta, omitted: present.filter(([, value]) => value !== undefined).map(([field]) => field) },
    diff,
    reviewers,
    judge,
    dedup,
    ...(context.recap && { recap: { ...context.recap, reclassifiedPriors: undefined } }),
  };
}

/** Whether `body` carries a round record. */
export function hasReviewRecord(body: string): boolean {
  return body.includes('<!-- manki-context');
}

/**
 * Returns the JSON text of the round record in a review body, decompressed when needed, or the
 * error when it can't be decoded. Manki writes the record last, so only the last record
 * counts: an earlier one is quoted text.
 */
export function extractReviewRecords(body: string): { records: string[]; errors: string[] } {
  const last = [...body.matchAll(PLAIN_RE), ...body.matchAll(GZIP_RE)].sort((a, b) => b.index - a.index)[0];
  if (!last) return { records: [], errors: [] };
  if (last[0].startsWith('<!-- manki-context: ')) return { records: [last[1]], errors: [] };
  try {
    return { records: [gunzipSync(Buffer.from(last[1], 'base64'), { maxOutputLength: MAX_RECORD_BYTES }).toString('utf-8')], errors: [] };
  } catch (error) {
    return { records: [], errors: [error instanceof Error ? error.message : String(error)] };
  }
}
