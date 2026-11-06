import { gunzipSync, gzipSync } from 'zlib';

import type { RoundContext } from './types';
import { redactSecrets, sanitizeHtmlCommentJson } from './utils';

const PLAIN_RE = /<!-- manki-context: (.+?) -->/g;
const GZIP_RE = /<!-- manki-context-gzip: ([A-Za-z0-9+/=]+) -->/g;
/** The visible block releases before v7 wrote, read so their round history still loads. */
const DETAILS_RE = /<details>\s*<summary>Manki context<\/summary>\s*```json\s*([\s\S]*?)```\s*<\/details>/g;

/**
 * Returns the round context as a hidden HTML comment: plain JSON when it fits in `room`
 * characters, otherwise gzip compressed and base64 encoded.
 */
export function formatReviewRecord(context: RoundContext, room: number = Infinity): string {
  const ctx = context.judge.threadEvaluations?.length === 0
    ? { ...context, judge: { ...context.judge, threadEvaluations: undefined } }
    : context;
  // Redacted here because the request hook that redacts posted text can't see inside a compressed record.
  const json = redactSecrets(JSON.stringify(ctx));
  const plain = `<!-- manki-context: ${sanitizeHtmlCommentJson(json)} -->`;
  if (plain.length <= room) return plain;
  return `<!-- manki-context-gzip: ${gzipSync(json).toString('base64')} -->`;
}

/**
 * Returns `context` without its per-file and per-finding diagnostics, keeping what later rounds read:
 * the findings, thread evaluations, verdict and counts.
 */
export function omitBulkyDiagnostics(context: RoundContext): RoundContext {
  const { perFile: _perFile, excludedFiles: _excludedFiles, binarySkipped: _binarySkipped, ...diff } = context.diff;
  const { rawFindings: _rawFindings, ...reviewers } = context.reviewers;
  const { dropped: _dropped, ...judge } = context.judge;
  const { duplicateMatches: _duplicateMatches, staticSignalMatches: _staticSignalMatches, ...dedup } = context.dedup;
  return {
    ...context,
    meta: { ...context.meta, diagnosticsOmitted: true },
    diff,
    reviewers,
    judge,
    dedup,
    ...(context.recap && { recap: { ...context.recap, reclassifiedPriors: undefined } }),
  };
}

/** Whether `body` carries a round record in any format Manki has written. */
export function hasReviewRecord(body: string): boolean {
  return body.includes('<!-- manki-context') || body.includes('<summary>Manki context</summary>');
}

/**
 * Returns the JSON text of every round record in a review body, decompressing compressed ones.
 * Throws when a compressed record can't be decoded.
 */
export function extractReviewRecords(body: string): string[] {
  const details = [...body.matchAll(DETAILS_RE)].map(m => m[1]);
  if (details.length > 0) return details;
  return [
    ...[...body.matchAll(PLAIN_RE)].map(m => m[1]),
    ...[...body.matchAll(GZIP_RE)].map(m => gunzipSync(Buffer.from(m[1], 'base64')).toString('utf-8')),
  ];
}
