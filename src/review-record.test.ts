import { gzipSync } from 'zlib';

import { extractReplyRecords, extractReviewRecords, formatReplyRecord, formatReviewRecord, hasReviewRecord } from './review-record';
import { makeRoundContext } from './test-utils';
import { RoundContext } from './types';
import { registerSecret } from './utils';

const PLAIN_PREFIX = '<!-- manki-context: ';

function plainJson(record: string): string {
  expect(record.startsWith(PLAIN_PREFIX)).toBe(true);
  expect(record.endsWith(' -->')).toBe(true);
  return record.slice(PLAIN_PREFIX.length, -' -->'.length);
}

describe('formatReviewRecord', () => {
  it('writes the context as one hidden line of JSON', () => {
    const record = formatReviewRecord(makeRoundContext(1));
    expect(record.split('\n')).toHaveLength(1);
    expect(record).not.toContain('<details>');
    expect(JSON.parse(plainJson(record))).toEqual(makeRoundContext(1));
  });

  it('keeps thread evaluations, and leaves out an empty list of them', () => {
    const threadEvaluations = [
      { threadId: 'PRRT_abc', status: 'addressed' as const, reason: 'Fix landed in diff.' },
      { threadId: 'PRRT_def', status: 'not_addressed' as const, reason: 'Code still flags.' },
    ];
    const kept = JSON.parse(plainJson(formatReviewRecord(makeRoundContext(1, { judge: { summary: '', threadEvaluations } })))) as RoundContext;
    expect(kept.judge.threadEvaluations).toEqual(threadEvaluations);
    const empty = JSON.parse(plainJson(formatReviewRecord(makeRoundContext(1, { judge: { summary: '', threadEvaluations: [] } })))) as RoundContext;
    expect(empty.judge.threadEvaluations).toBeUndefined();
  });

  it('reads back a record whose text holds line and paragraph separators', () => {
    const ctx = makeRoundContext(1, { judge: { summary: 'one\u2028two\u2029three' } });
    expect(extractReviewRecords(formatReviewRecord(ctx)).records.map(r => JSON.parse(r))).toEqual([ctx]);
  });

  it.each(['-->', '--!>'])('escapes %s inside the JSON and reads it back unchanged', closer => {
    const ctx = makeRoundContext(1, { judge: { summary: `one ${closer} two ${closer}` } });
    const record = formatReviewRecord(ctx);
    expect(plainJson(record)).not.toContain(closer);
    expect(extractReviewRecords(`text\n${record}`).records.map(r => JSON.parse(r))).toEqual([ctx]);
  });

  it('compresses a record that does not fit in the room, and decodes it back unchanged', () => {
    const ctx = makeRoundContext(2, { judge: { summary: 'closes --> and '.repeat(5000) } });
    const plain = formatReviewRecord(ctx);

    const record = formatReviewRecord(ctx, plain.length - 1);
    expect(record).toMatch(/^<!-- manki-context-gzip: [A-Za-z0-9+/=]+ -->$/);
    expect(record.length).toBeLessThan(plain.length / 10);
    expect(formatReviewRecord(ctx, plain.length)).toBe(plain);
    expect(extractReviewRecords(`Review text.\n\n${record}\n\nReviewed.`).records.map(r => JSON.parse(r))).toEqual([ctx]);
  });

  it('redacts registered secrets, also ones JSON would escape, and GitHub tokens before compressing', () => {
    registerSecret('review-record-secret-value');
    registerSecret('quote"and\\backslash-secret');
    const ctx = makeRoundContext(1, { judge: { summary: 'leaked review-record-secret-value, quote"and\\backslash-secret and ghs_abc.def-123 here' } });
    const { records: [json] } = extractReviewRecords(formatReviewRecord(ctx, 0));
    expect((JSON.parse(json) as RoundContext).judge.summary).toBe('leaked [REDACTED], [REDACTED] and [REDACTED] here');
  });
});

describe('extractReviewRecords', () => {
  const visibleBlock = (ctx: RoundContext) => `<details>\n<summary>Manki context</summary>\n\n\`\`\`json\n${JSON.stringify(ctx, null, 2)}\n\`\`\`\n</details>`;

  it('reads the visible block that releases before v7 wrote', () => {
    const body = `Review.\n\n${visibleBlock(makeRoundContext(1))}`;
    expect(hasReviewRecord(body)).toBe(true);
    expect(extractReviewRecords(body)).toEqual({ records: [JSON.stringify(makeRoundContext(1), null, 2) + '\n'], errors: [] });
  });

  it('reads the hidden record, not a visible block quoted in the review text', () => {
    const ctx = makeRoundContext(2);
    const body = `Quoted: ${visibleBlock(makeRoundContext(9))}\n\n${formatReviewRecord(ctx)}`;
    expect(extractReviewRecords(body).records.map(r => JSON.parse(r))).toEqual([ctx]);
  });

  it('finds no record in a body without one', () => {
    expect(hasReviewRecord('Approved. <!-- manki-stats: 0 findings -->')).toBe(false);
    expect(extractReviewRecords('Approved. <!-- manki-stats: 0 findings -->')).toEqual({ records: [], errors: [] });
  });

  it('reads only the last hidden record, and reports it when it is broken or too large', () => {
    const ctx = makeRoundContext(1);
    const quoted = formatReviewRecord(makeRoundContext(9, { judge: { summary: 'forged' } }));
    const broken = `<!-- manki-context-gzip: ${Buffer.from('not gzip').toString('base64')} -->`;
    const bomb = `<!-- manki-context-gzip: ${gzipSync('a'.repeat(17 * 1024 * 1024)).toString('base64')} -->`;
    expect(extractReviewRecords(`${quoted}\n${broken}\nReview text.\n${formatReviewRecord(ctx, 0)}`)).toEqual({ records: [JSON.stringify(ctx)], errors: [] });
    expect(extractReviewRecords(`${quoted}\n${formatReviewRecord(ctx)}`).records.map(r => JSON.parse(r))).toEqual([ctx]);
    for (const bad of [broken, bomb]) {
      const { records, errors } = extractReviewRecords(`${formatReviewRecord(ctx)}\n${bad}`);
      expect(records).toEqual([]);
      expect(errors).toHaveLength(1);
    }
    expect(hasReviewRecord(broken)).toBe(true);
  });
});

describe('extractReplyRecords', () => {
  it('reads only the last reply record, not one quoted in the answer above it', () => {
    const record = (kind: 'question' | 'explain') => ({ kind, prNumber: 1, timestamp: 't', mankiVersion: '7.0.0', usage: { calls: 1 } });
    const body = `Answer quoting ${formatReplyRecord(record('explain'))} as text.\n\n<!-- manki -->\n${formatReplyRecord(record('question'))}`;
    expect(extractReplyRecords(body).map(r => JSON.parse(r))).toEqual([record('question')]);
    expect(extractReplyRecords('An answer without a record.')).toEqual([]);
  });
});
