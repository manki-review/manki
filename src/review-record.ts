import { gunzipSync, gzipSync } from 'zlib';

import type { RoundContext } from './types';
import { redactSecrets, sanitizeHtmlCommentJson, sanitizeTokens } from './utils';

const PLAIN_RE = /<!-- manki-context: ([\s\S]+?) -->/g;
const GZIP_RE = /<!-- manki-context-gzip: ([A-Za-z0-9+/=]+) -->/g;
/** The visible block releases before v7 wrote, read so their round history still loads. */
const DETAILS_RE = /<details>\s*<summary>Manki context<\/summary>\s*```json\s*([\s\S]*?)```\s*<\/details>/g;
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
  // Redacted here because nothing that scans posted text can see inside a compressed record.
  const json = sanitizeTokens(redactSecrets(JSON.stringify(ctx)));
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
 * Returns the JSON text of every round record in a review body, decompressing compressed ones,
 * and an error for each compressed record that can't be decoded. The visible block of older
 * releases is read only when the body has no hidden record, since record text can quote one.
 */
export function extractReviewRecords(body: string): { records: string[]; errors: string[] } {
  const records = [...body.matchAll(PLAIN_RE)].map(m => m[1]);
  const errors: string[] = [];
  for (const m of body.matchAll(GZIP_RE)) {
    try {
      records.push(gunzipSync(Buffer.from(m[1], 'base64'), { maxOutputLength: MAX_RECORD_BYTES }).toString('utf-8'));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (records.length === 0 && errors.length === 0) {
    records.push(...[...body.matchAll(DETAILS_RE)].map(m => m[1]));
  }
  return { records, errors };
}
