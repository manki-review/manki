import type { LLMCall } from '../src/providers';
import { formatReplyRecord, formatReviewRecord } from '../src/review-record';
import { makeRoundContext } from '../src/test-utils';
import { callLines, historyLines } from './review-history';

const call = (stage: string, extra: Partial<LLMCall> = {}): LLMCall => ({
  stage, attempt: 1, durationMs: 10, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.001, ...extra,
});

describe('review history', () => {
  const bot = { login: 'manki-review[bot]', type: 'Bot' };

  it('prints one line per bot record, plain or compressed, and skips other reviews and broken records', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const plain = makeRoundContext(1);
    const compressed = makeRoundContext(2, { judge: { summary: 'long '.repeat(2000) } });
    const reply = { kind: 'question' as const, prNumber: 9, timestamp: '2026-11-02T00:00:00Z', mankiVersion: '7.0.0', usage: { calls: 1, llmCalls: [call('reply')] } };
    const reviews = [
      { id: 1, body: `Review.\n${formatReviewRecord(plain)}`, user: bot, commit_id: 'sha1', submitted_at: '2026-11-01T00:00:00Z' },
      { id: 2, body: 'A human review.', user: { login: 'someone', type: 'User' } },
      { id: 3, body: `Review.\n${formatReviewRecord(compressed, 0)}`, user: bot },
      { id: 5, body: '<!-- manki-context-gzip: bm90IGd6aXA= -->', user: bot },
      { id: 6, body: '<!-- manki-context: {not json} -->', user: bot },
      { id: 7, body: null, user: bot },
      { id: 8, body: `Pasted.\n${formatReviewRecord(plain)}`, user: { login: 'someone', type: 'User' } },
    ];
    const comments = [
      { id: 20, body: `An answer.\n\n<!-- manki -->\n${formatReplyRecord(reply)}`, user: bot, created_at: '2026-11-02T00:00:00Z' },
      { id: 21, body: `Pasted.\n\n<!-- manki -->\n${formatReplyRecord(reply)}`, user: { login: 'someone', type: 'User' } },
      // A bot comment that only quotes a record, without Manki's marker line above it, holds none.
      { id: 22, body: `Quoted.\n${formatReplyRecord(reply)}`, user: bot, created_at: '2026-11-03T00:00:00Z' },
      { id: 22, body: 'A finding without a record.', user: bot },
    ];

    expect(historyLines('owner/repo', 9, { reviews, comments })).toEqual([
      { kind: 'round', repo: 'owner/repo', pr: 9, sourceId: 1, author: 'manki-review[bot]', commitId: 'sha1', postedAt: '2026-11-01T00:00:00Z', record: plain },
      { kind: 'round', repo: 'owner/repo', pr: 9, sourceId: 3, author: 'manki-review[bot]', record: compressed },
      { kind: 'reply', repo: 'owner/repo', pr: 9, sourceId: 20, author: 'manki-review[bot]', postedAt: '2026-11-02T00:00:00Z', record: reply },
    ]);
    expect(errorSpy).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });

  it('prints one line per LLM call, with where it was recorded, and none for records without calls', () => {
    const judge = call('judge', { model: 'claude-opus-5-5' });
    const finder = call('reviewer', { agent: 'Finder', model: 'claude-sonnet-5-5' });
    const reply = call('reply');
    const round = makeRoundContext(2, { usage: { calls: 2, llmCalls: [finder, judge] } });
    const replyRecord = { kind: 'thread-reply' as const, prNumber: 9, timestamp: 't', mankiVersion: '7.0.0', usage: { llmCalls: [reply] } };
    const lines = historyLines('owner/repo', 9, {
      reviews: [
        { id: 1, body: formatReviewRecord(round), user: bot },
        { id: 2, body: formatReviewRecord(makeRoundContext(1)), user: bot },
      ],
      comments: [{ id: 20, body: `Fixed.\n\n<!-- manki -->\n${formatReplyRecord(replyRecord)}`, user: bot }],
    });

    const source = { repo: 'owner/repo', pr: 9, author: 'manki-review[bot]' };
    expect(callLines(lines)).toEqual([
      { kind: 'round', ...source, sourceId: 1, round: 2, ...finder },
      { kind: 'round', ...source, sourceId: 1, round: 2, ...judge },
      { kind: 'reply', ...source, sourceId: 20, ...reply },
    ]);
  });
});
