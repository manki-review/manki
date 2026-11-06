import { gzipSync } from 'zlib';

import { extractReviewRecords, formatReviewRecord, hasReviewRecord } from './review-record';
import { makeRoundContext } from './test-utils';
import { RoundContext } from './types';

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

  it.each(['-->', '--!>'])('escapes %s inside the JSON and reads it back unchanged', closer => {
    const ctx = makeRoundContext(1, { judge: { summary: `one ${closer} two ${closer}` } });
    const record = formatReviewRecord(ctx);
    expect(plainJson(record)).not.toContain(closer);
    expect(extractReviewRecords(`text\n${record}`).map(r => JSON.parse(r))).toEqual([ctx]);
  });

  it('compresses a record that does not fit in the room, and decodes it back unchanged', () => {
    const ctx = makeRoundContext(2, { judge: { summary: 'closes --> and '.repeat(5000) } });
    const plain = formatReviewRecord(ctx);

    const record = formatReviewRecord(ctx, plain.length - 1);
    expect(record).toMatch(/^<!-- manki-context-gzip: [A-Za-z0-9+/=]+ -->$/);
    expect(record.length).toBeLessThan(plain.length / 10);
    expect(formatReviewRecord(ctx, plain.length)).toBe(plain);
    expect(extractReviewRecords(`Review text.\n\n${record}\n\nReviewed.`).map(r => JSON.parse(r))).toEqual([ctx]);
  });
});

describe('extractReviewRecords', () => {
  it('reads the visible block that releases before v7 wrote', () => {
    const json = JSON.stringify(makeRoundContext(1), null, 2);
    const body = `Review.\n\n<details>\n<summary>Manki context</summary>\n\n\`\`\`json\n${json}\n\`\`\`\n</details>`;
    expect(hasReviewRecord(body)).toBe(true);
    expect(extractReviewRecords(body).map(r => JSON.parse(r))).toEqual([makeRoundContext(1)]);
  });

  it('finds no record in a body without one', () => {
    expect(hasReviewRecord('Approved. <!-- manki-stats: 0 findings -->')).toBe(false);
    expect(extractReviewRecords('Approved. <!-- manki-stats: 0 findings -->')).toEqual([]);
  });

  it('throws on a compressed record that is not valid gzip', () => {
    const body = `<!-- manki-context-gzip: ${Buffer.from('not gzip').toString('base64')} -->`;
    expect(hasReviewRecord(body)).toBe(true);
    expect(() => extractReviewRecords(body)).toThrow();
    expect(extractReviewRecords(`<!-- manki-context-gzip: ${gzipSync('{}').toString('base64')} -->`)).toEqual(['{}']);
  });
});
