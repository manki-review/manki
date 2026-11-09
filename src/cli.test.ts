import { exitCodeOf, formatReviewJson, formatReviewText, parseReviewArgs } from './cli';
import type { LocalReview } from './local-review';
import type { Finding, RoundContext, RoundOutcome } from './types';

const finding: Finding = {
  severity: 'blocker', title: 'Off by one', file: 'src/a.ts', line: 2, description: 'Reads past the end.', suggestedFix: 'Stop at `len - 1`.',
  reviewers: ['reviewer'], evidence: { checks: ['src/a.ts:2 reads `items[len]`'], proof: ['src/a.ts:2'] },
};

function review(outcome: RoundOutcome, findings: Finding[] = []): LocalReview {
  return {
    result: { verdict: outcome === 'READY' ? 'APPROVE' : 'REQUEST_CHANGES', outcome, summary: 'Summary of the round', findings, highlights: [], reviewComplete: outcome !== 'INCOMPLETE', agentNames: ['reviewer'] },
    context: {} as RoundContext,
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
  };
}

describe('parseReviewArgs', () => {
  it.each([
    [[], { head: 'HEAD' }],
    [['main'], { base: 'main', head: 'HEAD' }],
    [['main..topic'], { base: 'main', head: 'topic' }],
    [['origin/main...topic'], { base: 'origin/main', head: 'topic' }],
    [['--patch', 'p.diff', '--config', 'c.yml', '--title', 'T', '--body-file', 'b.md', '--record', 'r.json', '--json'],
      { head: 'HEAD', patch: 'p.diff', config: 'c.yml', title: 'T', bodyFile: 'b.md', record: 'r.json', json: true }],
    [['--help'], { help: true }],
  ])('reads %j', (argv, expected) => {
    expect(parseReviewArgs(argv)).toMatchObject({ json: false, help: false, ...expected });
  });

  it.each([
    [['--record'], '--record requires a value'],
    [['--title', '--json'], '--title requires a value'],
    [['--bogus'], 'Unknown option --bogus'],
    [['main', 'topic'], 'Unexpected argument topic'],
    [['..topic'], 'No base in ..topic'],
  ])('refuses %j', (argv, message) => {
    expect(() => parseReviewArgs(argv)).toThrow(message);
  });
});

describe('exitCodeOf', () => {
  it.each([
    ['READY', 0],
    ['ADDRESS_FIRST', 1],
    ['NOT_CONVERGING', 1],
    ['INCOMPLETE', 2],
  ] as const)('exits %s with %i', (outcome, code) => {
    expect(exitCodeOf(review(outcome))).toBe(code);
  });
});

describe('formatReviewJson', () => {
  it('round-trips the outcome, summary and findings', () => {
    const local = review('ADDRESS_FIRST', [finding]);
    expect(JSON.parse(formatReviewJson(local))).toEqual({
      outcome: 'ADDRESS_FIRST', verdict: 'REQUEST_CHANGES', summary: 'Summary of the round', base: local.base, head: local.head, findings: [finding],
    });
  });
});

describe('formatReviewText', () => {
  it('lists the outcome, the summary and each finding with its location, fix and checks, without hidden markers', () => {
    const text = formatReviewText(review('ADDRESS_FIRST', [finding]));
    expect(text).toMatch(/^## Changes requested: aaaaaaa\.\.bbbbbbb\n\nSummary of the round\n/);
    expect(text).toContain('**Off by one**');
    expect(text).toContain('`src/a.ts:2`');
    expect(text).toContain('Reads past the end.');
    expect(text).toContain('Stop at `len - 1`.');
    expect(text).toContain('On the flagged line: Reads `items[len]`');
    expect(text).not.toContain('<!--');
  });

  it('shows only the outcome and summary when nothing was found', () => {
    expect(formatReviewText(review('READY'))).toBe('## Approved: aaaaaaa..bbbbbbb\n\nSummary of the round\n');
  });
});
