import { gzipSync } from 'zlib';

import { extractReplyRecords, extractReviewRecords, formatReplyRecord, formatReviewRecord, hasOwnMarker, hasReviewRecord } from './review-record';
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
    // Quoted text that opens a record and never closes it takes nothing from the record below it.
    for (const opener of ['<!-- manki-context: {"meta":', 'Fix it with <!-- manki-context: ', '<!-- manki-context-gzip: ']) {
      expect(extractReviewRecords(`Review text.\n${opener}\nMore text.\n\n${formatReviewRecord(ctx)}\n\n<!-- manki-bot -->`).records.map(r => JSON.parse(r))).toEqual([ctx]);
    }
    // A record whose own text opens one is still read whole.
    const echoing = makeRoundContext(2, { judge: { summary: 'quotes <!-- manki-context: {} and <!-- manki-no-verdict -->' } });
    expect(extractReviewRecords(`${formatReviewRecord(ctx)}\n\n${formatReviewRecord(echoing)}`).records.map(r => JSON.parse(r))).toEqual([echoing]);
  });

  it('counts a flag marker only on a line of its own below the round record', () => {
    const flag = '<!-- manki-no-verdict -->';
    const record = formatReviewRecord(makeRoundContext(1, { judge: { summary: `quotes ${flag}` } }));
    const footer = '<details>\n<summary>About this review</summary>\n\n- Reviewed\n\n</details>\n\n<!-- manki-bot -->';
    expect(hasOwnMarker(`Review text.\n\n${record}\n\n${flag}\n\n${footer}`, flag)).toBe(true);
    expect(hasOwnMarker(`Review text.\r\n\r\n${record}\r\n\r\n${flag}\r\n\r\n<!-- manki-bot -->`, flag)).toBe(true);
    // A review without a record holds no quoted text, so its own marker counts anywhere.
    expect(hasOwnMarker(`Approved.\n\n<!-- manki -->\n${flag}`, flag)).toBe(true);
    // Above the record, the marker is text a finding quoted. Inside the record, it is JSON.
    expect(hasOwnMarker(`\`\`\`\n${flag}\n\`\`\`\n\n${record}\n\n${footer}`, flag)).toBe(false);
    expect(hasOwnMarker(`${record}\n\nFound by \`${flag}\`\n\n<!-- manki-bot -->`, flag)).toBe(false);
    expect(hasOwnMarker(`Review text.\n\n${record}`, flag)).toBe(false);
  });
});

describe('extractReplyRecords', () => {
  it('reads only the last reply record, not one quoted in the answer above it', () => {
    const record = (kind: 'question' | 'explain') => ({ kind, prNumber: 1, timestamp: 't', mankiVersion: '7.0.0', usage: { calls: 1 } });
    const body = `Answer quoting ${formatReplyRecord(record('explain'))} as text.\n\n<!-- manki -->\n${formatReplyRecord(record('question'))}`;
    expect(extractReplyRecords(body).map(r => JSON.parse(r))).toEqual([record('question')]);
    expect(extractReplyRecords('An answer without a record.')).toEqual([]);
    expect(extractReplyRecords(`Answer.\n<!-- manki-reply-record: {"kind":\n\n<!-- manki -->\n${formatReplyRecord(record('question'))}`).map(r => JSON.parse(r))).toEqual([record('question')]);
  });
});
