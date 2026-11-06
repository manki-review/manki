import { formatReviewRecord } from '../src/review-record';
import { makeRoundContext } from '../src/test-utils';
import { historyLines } from './review-history';

describe('review history', () => {
  it('prints one line per bot record in every format, and skips other reviews and broken records', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const plain = makeRoundContext(1);
    const compressed = makeRoundContext(2, { judge: { summary: 'long '.repeat(2000) } });
    const visible = makeRoundContext(3);
    const bot = { login: 'manki-review[bot]', type: 'Bot' };
    const reviews = [
      { id: 1, body: `Review.\n${formatReviewRecord(plain)}`, user: bot, commit_id: 'sha1', submitted_at: '2026-11-01T00:00:00Z' },
      { id: 2, body: 'A human review.', user: { login: 'someone', type: 'User' } },
      { id: 3, body: `Review.\n${formatReviewRecord(compressed, 0)}`, user: bot },
      { id: 4, body: `<details>\n<summary>Manki context</summary>\n\n\`\`\`json\n${JSON.stringify(visible, null, 2)}\n\`\`\`\n</details>`, user: bot },
      { id: 5, body: '<!-- manki-context-gzip: bm90IGd6aXA= -->', user: bot },
      { id: 6, body: '<!-- manki-context: {not json} -->', user: bot },
      { id: 7, body: null, user: bot },
      { id: 8, body: `Pasted.\n${formatReviewRecord(plain)}`, user: { login: 'someone', type: 'User' } },
    ];

    expect(historyLines('owner/repo', 9, reviews)).toEqual([
      { repo: 'owner/repo', pr: 9, reviewId: 1, author: 'manki-review[bot]', commitId: 'sha1', submittedAt: '2026-11-01T00:00:00Z', record: plain },
      { repo: 'owner/repo', pr: 9, reviewId: 3, author: 'manki-review[bot]', record: compressed },
      { repo: 'owner/repo', pr: 9, reviewId: 4, author: 'manki-review[bot]', record: visible },
    ]);
    expect(errorSpy).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });
});
