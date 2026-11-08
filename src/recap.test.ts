import { Finding, FindingFingerprintEntry, RoundContext } from './types';
import { classifyAuthorReply, collectInPrSuppressions, collectResolvedThreadIds, deduplicateFindings, fingerprintFinding, PreviousFinding, fetchRecapState, REOPENED_MARKER, securityOverrideMarker, titlesOverlap, titleOverlapType, refreshAuthorReplyClass, llmDeduplicateFindings, parseFindingFromComment } from './recap';
import { AUTO_APPROVE_MARKER, BOT_LOGIN, formatFindingComment, titleToSlug } from './github';
import { LAST_PAGE, paginateSinglePage, TEST_BOT, TEST_LINKS } from './test-utils';
import { determineOutcome } from './review';
import { applyCrossRoundSuppression } from './judge';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

import * as core from '@actions/core';

const makeFinding = (overrides: Partial<Finding> = {}): Finding => ({
  severity: 'suggestion',
  title: 'Test finding',
  file: 'src/index.ts',
  line: 10,
  description: 'A test finding',
  reviewers: ['TestReviewer'],
  ...overrides,
});

const makePrevious = (overrides: Partial<PreviousFinding> = {}): PreviousFinding => ({
  title: 'Test finding',
  file: 'src/index.ts',
  line: 10,
  severity: 'suggestion',
  status: 'open',
  ...overrides,
});

describe('deduplicateFindings', () => {
  it('detects exact match by title, file, and line', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42, status: 'resolved' })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].matchType).toBe('exact');

    const fixed = makePrevious({ ...previous[0], line: 40, fixed: true });
    const kept = deduplicateFindings(findings, [fixed]);
    expect(kept.duplicates).toHaveLength(0);
    expect(kept.unique).toEqual([{ ...findings[0], resemblesFixed: { title: 'Missing null check', file: 'src/foo.ts', line: 40 } }]);
    expect(deduplicateFindings(findings, [fixed, ...previous]).duplicates).toHaveLength(1);
  });

  it('drops a repeat of an answered thread on a file unchanged since the last round, and sends any other to the judge with the answer', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];
    const answered = makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42, status: 'auto-resolved', threadId: 'T1', answer: 'Withdrawn. `id` is checked first.' });

    expect(deduplicateFindings(findings, [answered], new Set(['src/bar.ts']))).toEqual({
      unique: [],
      duplicates: [{ finding: findings[0], matchedTitle: 'Missing null check', matchType: 'exact' }],
    });
    const toJudge = [{ ...findings[0], answeredIn: { threadId: 'T1', answer: 'Withdrawn. `id` is checked first.' } }];
    expect(deduplicateFindings(findings, [answered], new Set(['src/foo.ts'])).unique).toEqual(toJudge);
    expect(deduplicateFindings(findings, [answered]).unique).toEqual(toJudge);
    expect(deduplicateFindings(findings, [{ ...answered, line: 0, originalLine: 41 }]).unique).toEqual(toJudge);
    expect(deduplicateFindings(findings, [{ ...answered, originalLine: 10 }]).unique).toEqual(toJudge);
    expect(deduplicateFindings(findings, [{ ...answered, answer: undefined }], new Set()).unique).toEqual(findings);
    const unrelated = [makeFinding({ title: 'Unrelated race', file: 'src/foo.ts', line: 42 })];
    expect(deduplicateFindings(unrelated, [answered], new Set()).unique).toEqual(unrelated);
  });

  it('attributes match types: exact, substring, word_overlap', () => {
    const findings = [
      makeFinding({ title: 'Missing null check', file: 'src/a.ts', line: 10 }),
      makeFinding({ title: 'Missing null check in processBlock', file: 'src/b.ts', line: 10 }),
      makeFinding({ title: 'FFI API regression: is_ours removed with no replacement', file: 'src/c.rs', line: 10 }),
    ];
    const previous = [
      makePrevious({ title: 'Missing null check', file: 'src/a.ts', line: 10, status: 'resolved' }),
      makePrevious({ title: 'Missing null check', file: 'src/b.ts', line: 10, status: 'resolved' }),
      makePrevious({ title: 'FFI removes is_ours without adding replacement', file: 'src/c.rs', line: 10, status: 'resolved' }),
    ];

    const result = deduplicateFindings(findings, previous);
    expect(result.duplicates).toHaveLength(3);
    expect(result.duplicates.map(d => d.matchType)).toEqual(['exact', 'substring', 'word_overlap']);
  });

  it('detects fuzzy line match within +/-5 lines', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 45 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42, status: 'resolved' })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
  });

  it('does not match different file with same title', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/bar.ts', line: 42 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42, status: 'resolved' })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });

  it('does not match different title with same file and line', () => {
    const findings = [makeFinding({ title: 'Unused variable', file: 'src/foo.ts', line: 42 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42, status: 'resolved' })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });

  it('returns all findings as unique when previous is empty', () => {
    const findings = [
      makeFinding({ title: 'A' }),
      makeFinding({ title: 'B' }),
    ];

    const result = deduplicateFindings(findings, []);
    expect(result.unique).toHaveLength(2);
    expect(result.duplicates).toHaveLength(0);
  });

  it('does not match when previous title is empty', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];
    const previous = [makePrevious({ title: '', file: 'src/foo.ts', line: 42, status: 'resolved' })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });

  it('does not match when finding title is shorter than 3 characters', () => {
    const findings = [makeFinding({ title: 'AB', file: 'src/foo.ts', line: 42 })];
    const previous = [makePrevious({ title: 'AB', file: 'src/foo.ts', line: 42, status: 'resolved' })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });

  it('deduplicates against resolved previous findings', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42, status: 'resolved' })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
  });

  it('only deduplicates against resolved, not open previous findings', () => {
    const findings = [
      makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 42 }),
      makeFinding({ title: 'Unused import', file: 'src/bar.ts', line: 10 }),
    ];
    const previous = [
      makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42, status: 'open' }),
      makePrevious({ title: 'Unused import', file: 'src/bar.ts', line: 10, status: 'resolved' }),
    ];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0].title).toBe('Missing null check');
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].finding.title).toBe('Unused import');
  });

  it('matches by title substring', () => {
    const findings = [makeFinding({ title: 'Missing null check in processBlock', file: 'src/foo.ts', line: 42 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42, status: 'resolved' })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
  });

  it('matches rephrased title with word overlap', () => {
    const findings = [makeFinding({
      title: 'FFI API regression: is_ours removed with no replacement',
      file: 'src/ffi.rs',
      line: 50,
    })];
    const previous = [makePrevious({
      title: 'FFI removes is_ours without adding replacement',
      file: 'src/ffi.rs',
      line: 50,
      status: 'resolved',
    })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
  });

  it('does not match completely different titles', () => {
    const findings = [makeFinding({ title: 'Memory leak in connection pool', file: 'src/pool.ts', line: 10 })];
    const previous = [makePrevious({ title: 'Missing error handling in parser', file: 'src/pool.ts', line: 10, status: 'resolved' })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });

  it('matches same file + nearby line + word overlap as duplicate', () => {
    const findings = [makeFinding({
      title: 'Unsafe cast should use type guard',
      file: 'src/util.ts',
      line: 33,
    })];
    const previous = [makePrevious({
      title: 'Unsafe type cast without guard',
      file: 'src/util.ts',
      line: 30,
      status: 'resolved',
    })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
  });

  it('matches same file + far line when word overlap is high', () => {
    const findings = [makeFinding({
      title: 'Missing null check before dereference',
      file: 'src/foo.ts',
      line: 60,
    })];
    const previous = [makePrevious({
      title: 'Missing null check before dereference',
      file: 'src/foo.ts',
      line: 45,
      status: 'resolved',
    })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
  });

  it('does not match when line delta exceeds relaxed threshold', () => {
    const findings = [makeFinding({
      title: 'Missing null check before dereference',
      file: 'src/foo.ts',
      line: 70,
    })];
    const previous = [makePrevious({
      title: 'Missing null check before dereference',
      file: 'src/foo.ts',
      line: 45,
      status: 'resolved',
    })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });

  it('does not match different file even with matching title', () => {
    const findings = [makeFinding({
      title: 'Missing null check before dereference',
      file: 'src/bar.ts',
      line: 10,
    })];
    const previous = [makePrevious({
      title: 'Missing null check before dereference',
      file: 'src/foo.ts',
      line: 10,
      status: 'resolved',
    })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });

  it('returns matchedTitle with each static duplicate', () => {
    const findings = [
      makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 42 }),
      makeFinding({ title: 'Unused import in bar', file: 'src/bar.ts', line: 10 }),
    ];
    const previous = [
      makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42, status: 'resolved' }),
      makePrevious({ title: 'Unused import in bar', file: 'src/bar.ts', line: 10, status: 'resolved' }),
    ];

    const result = deduplicateFindings(findings, previous);
    expect(result.duplicates).toHaveLength(2);
    expect(result.duplicates[0].finding.title).toBe('Missing null check');
    expect(result.duplicates[0].matchedTitle).toBe('Missing null check');
    expect(result.duplicates[1].finding.title).toBe('Unused import in bar');
    expect(result.duplicates[1].matchedTitle).toBe('Unused import in bar');
  });

  it('returns matched previous title when titles differ via substring', () => {
    const findings = [makeFinding({ title: 'Missing null check in processBlock', file: 'src/foo.ts', line: 42 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42, status: 'resolved' })];

    const result = deduplicateFindings(findings, previous);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].finding.title).toBe('Missing null check in processBlock');
    expect(result.duplicates[0].matchedTitle).toBe('Missing null check');
  });

  it('does not suppress findings matching open previous findings', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42, status: 'open' })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });

  it('does not suppress findings matching replied previous findings', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42, status: 'replied' })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });
});

describe('classifyAuthorReply', () => {
  it('classifies acknowledgments as agree', () => {
    expect(classifyAuthorReply('Fixed, done.')).toBe('agree');
    expect(classifyAuthorReply('Good catch, will fix.')).toBe('agree');
    expect(classifyAuthorReply('Addressed in latest push.')).toBe('agree');
  });

  it('classifies pushback as disagree', () => {
    expect(classifyAuthorReply('This is intentional by design')).toBe('disagree');
    expect(classifyAuthorReply('Disagree, keeping as-is.')).toBe('disagree');
    expect(classifyAuthorReply('Not a bug, this is fine.')).toBe('disagree');
  });

  it('classifies partial acknowledgments as partial', () => {
    expect(classifyAuthorReply("I'll handle most of it in a follow-up")).toBe('partial');
    expect(classifyAuthorReply('Working on it')).toBe('partial');
    expect(classifyAuthorReply('Partially handled')).toBe('partial');
  });

  it('classifies a reply that opens with a dismiss command as agree', () => {
    expect(classifyAuthorReply('@manki dismiss')).toBe('agree');
    expect(classifyAuthorReply('/manki dismiss the token is test data')).toBe('agree');
    expect(classifyAuthorReply('Please do not @manki dismiss this.')).not.toBe('agree');
  });

  it('returns none for undefined or empty text', () => {
    expect(classifyAuthorReply(undefined)).toBe('none');
    expect(classifyAuthorReply('')).toBe('none');
  });

  it('classifies emoji reactions', () => {
    expect(classifyAuthorReply('\u{1F44D}')).toBe('agree');
    expect(classifyAuthorReply('\u{1F44E}')).toBe('disagree');
  });

  it('returns none for neutral text with no signal words', () => {
    expect(classifyAuthorReply('I will take a look later.')).toBe('none');
  });

  it('prefers agree over disagree when both signals are present', () => {
    expect(classifyAuthorReply('Good catch, but I disagree on severity.')).toBe('agree');
  });

  it('returns none for negated agree signals', () => {
    expect(classifyAuthorReply('not fixed')).toBe('none');
    expect(classifyAuthorReply('not addressed')).toBe('none');
    expect(classifyAuthorReply("didn't fix this")).toBe('none');
    expect(classifyAuthorReply('not resolved yet')).toBe('none');
    expect(classifyAuthorReply('not agreed')).toBe('none');
  });

  it('still classifies non-negated agree signals correctly', () => {
    expect(classifyAuthorReply('fixed now')).toBe('agree');
    expect(classifyAuthorReply('addressed in latest commit')).toBe('agree');
    expect(classifyAuthorReply('resolved by the refactor')).toBe('agree');
  });

  it('returns none for negated disagree signals', () => {
    expect(classifyAuthorReply('not intentional')).toBe('none');
    expect(classifyAuthorReply("wasn't intentional")).toBe('none');
  });

  it('still classifies disagree signals correctly when not negated', () => {
    expect(classifyAuthorReply('this is intentional')).toBe('disagree');
    expect(classifyAuthorReply('Not a bug, this is fine.')).toBe('disagree');
  });
});

describe('fingerprintFinding', () => {
  it('replaces non-alphanumeric characters in the slug', () => {
    const fp = fingerprintFinding('Hardcoded ServiceFlags::NETWORK', 'src/peer_store.rs', 42);
    expect(fp.slug).toBe('Hardcoded-ServiceFlags--NETWORK');
    expect(fp.file).toBe('src/peer_store.rs');
    expect(fp.lineStart).toBe(42);
    expect(fp.lineEnd).toBe(42);
  });

  it('supports multi-line ranges', () => {
    const fp = fingerprintFinding('Fix this', 'src/a.ts', 10, 15);
    expect(fp.lineStart).toBe(10);
    expect(fp.lineEnd).toBe(15);
  });

  it('collapses lineEnd to lineStart when omitted', () => {
    const fp = fingerprintFinding('Fix this', 'src/a.ts', 7);
    expect(fp.lineStart).toBe(7);
    expect(fp.lineEnd).toBe(7);
  });

  it('preserves alphanumeric characters in the slug', () => {
    const fp = fingerprintFinding('Null123 Check', 'a.ts', 1);
    expect(fp.slug).toBe('Null123-Check');
  });
});

describe('titlesOverlap', () => {
  it('matches identical titles', () => {
    expect(titlesOverlap('Missing null check', 'Missing null check')).toBe(true);
  });

  it('matches case-insensitive', () => {
    expect(titlesOverlap('Missing Null Check', 'missing null check')).toBe(true);
  });

  it('matches substring when shorter is >= 5 chars', () => {
    expect(titlesOverlap('Missing null check in processBlock', 'Missing null check')).toBe(true);
  });

  it('matches short title when word overlap is sufficient', () => {
    expect(titlesOverlap('Bug', 'Bug in parser')).toBe(true);
  });

  it('does not match short unrelated titles', () => {
    expect(titlesOverlap('Bug', 'Type error')).toBe(false);
  });

  it('matches by word overlap at 50% threshold', () => {
    expect(titlesOverlap(
      'FFI removes is_ours without adding replacement',
      'FFI API regression: is_ours removed with no replacement',
    )).toBe(true);
  });

  it('does not match completely unrelated titles', () => {
    expect(titlesOverlap(
      'Memory leak in connection pool',
      'Missing error handling in parser',
    )).toBe(false);
  });

  it('matches identical strings even when all words are short', () => {
    expect(titlesOverlap('a b c', 'a b c')).toBe(true);
  });

  it('returns false when all words are too short and strings differ', () => {
    expect(titlesOverlap('a b c', 'x y z')).toBe(false);
  });

  it('matches titles with punctuation-laden words', () => {
    expect(titlesOverlap(
      'regression: `is_ours` removed, error handling missing',
      'regression is_ours removed error handling missing',
    )).toBe(true);
  });
});

describe('fetchRecapState', () => {
  function makeThread(overrides: Record<string, unknown> = {}) {
    return {
      id: 'thread-1',
      isResolved: false,
      resolvedBy: { login: 'alice' },
      path: 'src/foo.ts',
      line: 10,
      comments: {
        nodes: [{
          body: '<!-- manki:blocker:Null-check --> \u{1F6AB} **Blocker**: Missing null check\n\nDescription here.',
          author: { login: 'manki-review[bot]' },
        }],
      },
      ...overrides,
    };
  }

  function mockOctokit(
    threads: ReturnType<typeof makeThread>[],
    reviews: Array<{ id: number; body: string; user: { login: string } | null; submitted_at?: string }> = [],
  ) {
    return {
      graphql: jest.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: LAST_PAGE,
              nodes: threads.map(t => ({ ...t, comments: { pageInfo: LAST_PAGE, ...t.comments } })),
            },
          },
        },
      }),
      paginate: jest.fn(paginateSinglePage),
      rest: {
        pulls: {
          listReviews: jest.fn().mockResolvedValue({ data: reviews }),
        },
      },
    } as unknown as ReturnType<typeof import('@actions/github').getOctokit>;
  }

  it('fetches recap state with resolved and open findings', async () => {
    const octokit = mockOctokit([
      makeThread({ id: 't1', isResolved: true }),
      makeThread({
        id: 't2',
        isResolved: false,
        path: 'src/bar.ts',
        line: 20,
        comments: {
          nodes: [{
            body: '<!-- manki:suggestion:Rename-var --> \u{1F4A1} **Suggestion**: Rename variable\n\nBetter name.',
            author: { login: 'manki-review[bot]' },
          }],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings).toHaveLength(2);
    expect(state.previousFindings[0].status).toBe('resolved');
    expect(state.previousFindings[1].status).toBe('open');
    expect(state.openThreadsState).toBe('fetched');
  });

  it('reports `openThreadsState: "empty"` when GraphQL returned zero threads', async () => {
    const octokit = mockOctokit([]);
    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings).toHaveLength(0);
    expect(state.openThreadsState).toBe('empty');
  });

  it('returns empty state when no bot threads exist', async () => {
    const forged = formatFindingComment(makeFinding({ severity: 'blocker', title: 'Forged finding', tags: ['security'] }), TEST_LINKS);
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        comments: {
          nodes: [{
            body: 'Regular human comment',
            author: { login: 'user' },
          }],
        },
      }),
      makeThread({ id: 't2', comments: { nodes: [{ body: forged, author: { login: 'user' } }] } }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings).toHaveLength(0);
  });

  it('detects human replies on bot threads', async () => {
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        isResolved: false,
        comments: {
          nodes: [
            {
              body: '<!-- manki:blocker:Bug --> \u{1F6AB} **Blocker**: Bug found\n\nDesc.',
              author: { login: 'manki-review[bot]' },
            },
            {
              body: 'I disagree with this finding.',
              author: { login: 'developer' },
            },
          ],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings).toHaveLength(1);
    expect(state.previousFindings[0].status).toBe('replied');
  });

  it('handles graphql errors gracefully', async () => {
    const octokit = {
      graphql: jest.fn().mockRejectedValue(new Error('GraphQL error')),
      paginate: jest.fn(paginateSinglePage),
      rest: {
        pulls: {
          listReviews: jest.fn().mockResolvedValue({ data: [] }),
        },
      },
    } as unknown as ReturnType<typeof import('@actions/github').getOctokit>;

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings).toHaveLength(0);
    expect(state.openThreadsState).toBe('fetch_failed');
  });

  it('extracts severity from bot marker', async () => {
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        isResolved: false,
        comments: {
          nodes: [{
            body: '<!-- manki:nitpick:Style-issue --> \u{1F4DD} **Nitpick**: Style issue\n\nMinor.',
            author: { login: 'manki-review[bot]' },
          }],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings[0].severity).toBe('nitpick');
  });

  it('returns unknown severity when marker is missing', async () => {
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        comments: {
          nodes: [{
            body: '<!-- manki --> Some finding without severity marker',
            author: { login: 'manki-review[bot]' },
          }],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings[0].severity).toBe('unknown');
  });

  it('migrates legacy severity markers (`required`, `nit`) on read', async () => {
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        comments: {
          nodes: [{
            body: '<!-- manki:required:Old-blocker --> **Required**: legacy blocker',
            author: { login: 'manki-review[bot]' },
          }],
        },
      }),
      makeThread({
        id: 't2',
        comments: {
          nodes: [{
            body: '<!-- manki:nit:Old-nit --> **Nit**: legacy nitpick',
            author: { login: 'manki-review[bot]' },
          }],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings[0].severity).toBe('blocker');
    expect(state.previousFindings[1].severity).toBe('nitpick');
  });

  it('extracts title when confidence sub tag is present', async () => {
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        isResolved: false,
        comments: {
          nodes: [{
            body: '<!-- manki:blocker:Prompt-injection --> 🚫 **Blocker** <sub>[high confidence]</sub>: Prompt injection via unsanitized file paths\n\nDescription.',
            author: { login: 'manki-review[bot]' },
          }],
        },
      }),
      makeThread({
        id: 't2',
        isResolved: false,
        path: 'src/bar.ts',
        line: 20,
        comments: {
          nodes: [{
            body: '<!-- manki:suggestion:LLM-dedup --> 💡 **Suggestion** <sub>[medium confidence]</sub>: LLM dedup only compares against resolved findings\n\nDetails.',
            author: { login: 'manki-review[bot]' },
          }],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings[0].title).toBe('Prompt injection via unsanitized file paths');
    expect(state.previousFindings[1].title).toBe('LLM dedup only compares against resolved findings');
  });

  it('handles null line in thread', async () => {
    const octokit = mockOctokit([
      makeThread({ id: 't1', line: null }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings[0].line).toBe(0);
  });

  it('extracts threadUrl from the first comment and exposes it on PreviousFinding', async () => {
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        comments: {
          nodes: [{
            body: '<!-- manki:blocker:Null-check --> \u{1F6AB} **Blocker**: Missing null check',
            url: 'https://github.com/owner/repo/pull/1#discussion_r123',
            author: { login: 'manki-review[bot]' },
          }],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings[0].threadUrl).toBe('https://github.com/owner/repo/pull/1#discussion_r123');
  });

  it('falls back to empty-string threadUrl when the first comment has no url', async () => {
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        comments: {
          nodes: [{
            body: '<!-- manki:blocker:Null-check --> \u{1F6AB} **Blocker**: Missing null check',
            author: { login: 'manki-review[bot]' },
          }],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings[0].threadUrl).toBe('');
  });

  it('treats last non-bot comment body as author reply text, and the latest Manki outcome or found-again reply as its answer', async () => {
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        isResolved: false,
        comments: {
          nodes: [
            {
              body: '<!-- manki:blocker:Bug --> \u{1F6AB} **Blocker**: Bug found\n\nDesc.',
              author: { login: 'manki-review[bot]' },
            },
            {
              body: 'Fixed, done.',
              author: { login: 'developer' },
            },
          ],
        },
      }),
      makeThread({
        id: 't2',
        comments: {
          nodes: [
            { body: '<!-- manki:blocker:Bug --> \u{1F6AB} **Blocker**: Bug found\n\nDesc.', author: { login: 'manki-review[bot]' } },
            { body: 'It is intended.', author: { login: 'developer' } },
            { body: '**Withdrawn.** `load` returns early.\n\n<!-- manki -->', author: { login: 'manki-review[bot]' } },
            { body: 'Agreed. Developer text that looks like an answer.', author: { login: 'developer' } },
            { body: 'Fixed in abc1234.\n\n<!-- manki -->', author: { login: 'manki-review[bot]' } },
          ],
        },
      }),
      makeThread({
        id: 't3',
        comments: {
          nodes: [
            { body: '<!-- manki:warning:Bug --> **Warning**: Bug found\n\nDesc.', author: { login: 'manki-review[bot]' } },
            { body: 'Agreed. Handling it later is fine.\n\n<!-- manki -->', author: { login: 'manki-review[bot]' } },
            { body: 'This came up again.\n\nDetails.\n\n<!-- manki -->\n<!-- manki-found-again -->\n<!-- manki-found-again-blocker -->', author: { login: 'manki-review[bot]' } },
          ],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings[0].authorReplyText).toBe('Fixed, done.');
    expect(state.previousFindings.map(f => f.answer)).toEqual([undefined, '**Withdrawn.** `load` returns early.', 'This came up again.\n\nDetails.']);
    expect(state.previousFindings.map(f => f.severity)).toEqual(['blocker', 'blocker', 'blocker']);
  });

  it('uses the latest non-bot reply when multiple human replies exist', async () => {
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        isResolved: false,
        comments: {
          nodes: [
            {
              body: '<!-- manki:required:Bug --> \u{1F6AB} **Required**: Bug found\n\nDesc.',
              author: { login: 'manki-review[bot]' },
            },
            {
              body: 'Fixed, done.',
              author: { login: 'developer' },
            },
            {
              body: 'Actually, disagree -- reverting.',
              author: { login: 'developer' },
            },
          ],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings[0].authorReplyText).toBe('Actually, disagree -- reverting.');
  });

  it('leaves authorReplyText undefined for threads with only bot comments', async () => {
    const octokit = mockOctokit([
      makeThread({ id: 't1' }),
      makeThread({
        id: 't2',
        comments: {
          nodes: [
            {
              body: '<!-- manki:required:Bug --> \u{1F6AB} **Required**: Bug found\n\nDesc.',
              author: { login: 'manki-review[bot]' },
            },
            {
              body: 'Follow-up bot reply from the App identity.',
              author: { login: 'manki-review[bot]' },
            },
            {
              body: 'Another follow-up from the Actions identity.',
              author: { login: 'manki-review[bot]' },
            },
            {
              body: 'GraphQL reports the App without the `[bot]` suffix.',
              author: { login: 'manki-review' },
            },
          ],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings[0].authorReplyText).toBeUndefined();
    expect(state.previousFindings[1].authorReplyText).toBeUndefined();
    expect(state.previousFindings[1].status).toBe('open');
  });

  it('reads every page of review threads and every comment of a long thread', async () => {
    const threads = Array.from({ length: 150 }, (_, i) => makeThread({ id: `t${i}`, line: i + 1 }));
    const longThread = threads[149];
    const botReplies = Array.from({ length: 9 }, (_, i) => ({ body: `Bot follow-up ${i}`, author: { login: 'manki-review[bot]' } }));
    threads[149] = {
      ...longThread,
      comments: { ...longThread.comments, pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [...longThread.comments.nodes, ...botReplies] },
    } as typeof longThread;
    let threadCommentsError: Error | null = null;
    const graphql = jest.fn(async (_query: string, vars: { cursor: string | null; threadId?: string }) => {
      if (vars.threadId) {
        if (threadCommentsError) throw threadCommentsError;
        return { node: { comments: { pageInfo: LAST_PAGE, nodes: [{ body: 'Final answer.', author: { login: 'developer' } }] } } };
      }
      const firstPage = vars.cursor === null;
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: firstPage ? { hasNextPage: true, endCursor: 'p2' } : LAST_PAGE,
              nodes: (firstPage ? threads.slice(0, 100) : threads.slice(100))
                .map(t => ({ ...t, comments: { pageInfo: LAST_PAGE, ...t.comments, nodes: [...t.comments.nodes] } })),
            },
          },
        },
      };
    });
    const octokit = { ...mockOctokit([]), graphql } as unknown as ReturnType<typeof mockOctokit>;

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(state.previousFindings).toHaveLength(150);
    expect(state.previousFindings[149]).toMatchObject({ status: 'replied', authorReplyText: 'Final answer.' });
    expect(graphql.mock.calls.map(([, vars]) => vars)).toEqual([
      expect.objectContaining({ cursor: null }),
      expect.objectContaining({ cursor: 'p2' }),
      { threadId: 't149', cursor: 'c1' },
    ]);

    threadCommentsError = new Error('network down');
    const partial = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(partial.openThreadsState).toBe('fetched');
    expect(partial.previousFindings).toHaveLength(150);
    expect(partial.previousFindings[149]).toMatchObject({ status: 'open', authorReplyText: undefined });
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('review thread t149, using the first 10: Error: network down'));
  });

  it('populates lineStart from startLine when present for multi-line annotations', async () => {
    const octokit = mockOctokit([
      makeThread({ id: 't1', line: 44, startLine: 40 }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings[0].line).toBe(44);
    expect(state.previousFindings[0].lineStart).toBe(40);
  });

  it('falls back lineStart to line when startLine is null', async () => {
    const octokit = mockOctokit([
      makeThread({ id: 't1', line: 42, startLine: null }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings[0].lineStart).toBe(42);
  });

  it('captures authorReplyLogin from the latest non-bot reply', async () => {
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        isResolved: false,
        comments: {
          nodes: [
            {
              body: '<!-- manki:suggestion:unused-var --> 💡 **Suggestion**: Unused variable\n\nDesc.',
              author: { login: 'manki-review[bot]' },
            },
            { body: 'Working on it.', author: { login: 'someone-else' } },
            { body: 'Fixed, done.', author: { login: 'pr-author' } },
          ],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings[0].authorReplyLogin).toBe('pr-author');
    expect(state.previousFindings[0].authorReplyText).toBe('Fixed, done.');
  });

  it('recovers `description` and `suggestedFix` from AI context JSON block in first comment', async () => {
    const aiContext = JSON.stringify({ fix: 'Add null check before dereferencing ptr.', flaggedBy: ['SecurityReviewer'] });
    const body = [
      '<!-- manki:blocker:Null-ptr --> 🚫 **Blocker**: Null pointer dereference',
      '',
      'The pointer is dereferenced without a prior null check.',
      '',
      '<details>',
      '<summary>AI context</summary>',
      '',
      '```json',
      aiContext,
      '```',
      '</details>',
    ].join('\n');

    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        isResolved: false,
        comments: { nodes: [{ body, author: { login: 'manki-review[bot]' } }] },
      }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings[0].description).toBe('The pointer is dereferenced without a prior null check.');
    expect(state.previousFindings[0].suggestedFix).toBe('Add null check before dereferencing ptr.');
  });

  it('recovers the title, `description` and `suggestedFix` from a comment posted by `formatFindingComment`', async () => {
    const body = formatFindingComment({
      severity: 'warning',
      title: 'Null pointer dereference',
      file: 'src/a.ts',
      line: 4,
      description: 'The pointer is dereferenced without a prior null check.',
      suggestedFix: 'if (!ptr) return;',
      reviewers: ['SecurityReviewer'],
    }, TEST_LINKS);
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        isResolved: false,
        comments: { nodes: [{ body, author: { login: 'manki-review[bot]' } }] },
      }),
    ]);

    const [finding] = (await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1)).previousFindings;
    expect(finding).toMatchObject({
      title: 'Null pointer dereference',
      severity: 'warning',
      markerSlug: 'Null-pointer-dereference',
      description: 'The pointer is dereferenced without a prior null check.…(truncated)',
      suggestedFix: 'if (!ptr) return;',
    });
  });

  it('skips `suggestedFix` when AI context JSON is malformed, still recovers `description`', async () => {
    const body = [
      '<!-- manki:warning:Bad-cast --> ⚠️ **Warning**: Unsafe cast',
      '',
      'Cast lacks a type guard.',
      '',
      '<details>',
      '<summary>AI context</summary>',
      '',
      '```json',
      '{ not valid json !!!',
      '```',
      '</details>',
    ].join('\n');

    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        isResolved: false,
        comments: { nodes: [{ body, author: { login: 'manki-review[bot]' } }] },
      }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings[0].description).toBe('Cast lacks a type guard.');
    expect(state.previousFindings[0].suggestedFix).toBeUndefined();
  });

  it('skips `suggestedFix` when AI context JSON has no `fix` field', async () => {
    const aiContext = JSON.stringify({ flaggedBy: ['Reviewer'], confidence: 'high' });
    const body = [
      '<!-- manki:suggestion:Rename --> 💡 **Suggestion**: Rename for clarity',
      '',
      'The variable name is misleading.',
      '',
      '<details>',
      '<summary>AI context</summary>',
      '',
      '```json',
      aiContext,
      '```',
      '</details>',
    ].join('\n');

    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        isResolved: false,
        comments: { nodes: [{ body, author: { login: 'manki-review[bot]' } }] },
      }),
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings[0].description).toBe('The variable name is misleading.');
    expect(state.previousFindings[0].suggestedFix).toBeUndefined();
  });

  describe('priorRounds parsing', () => {
    function makeRoundContext(round: number, overrides: Partial<RoundContext> = {}): RoundContext {
      const base: RoundContext = {
        meta: {
          prNumber: 42,
          commitSha: 'abc123',
          round,
          timestamp: '2026-01-01T00:00:00.000Z',
          mankiVersion: '4.7.0',
        },
        config: { reviewLevel: 'medium', memoryEnabled: false },
        diff: { lines: 100, additions: 60, deletions: 40, filesReviewed: 3, fileTypes: { '.ts': 3 } },
        models: { reviewer: 'r', judge: 'j' },
        planner: { source: 'disabled', used: false },
        reviewers: { agents: ['Correctness'] },
        judge: { summary: 'ok' },
        dedup: {},
        memory: {},
        findings: { count: 0, severityCounts: { blocker: 0, warning: 0, suggestion: 0, nitpick: 0 }, entries: [] },
        usage: {},
        verdict: 'COMMENT',
      };
      return { ...base, ...overrides, meta: { ...base.meta, ...(overrides.meta ?? {}), round } };
    }

    function htmlCommentBlock(ctx: RoundContext): string {
      const json = JSON.stringify(ctx).replace(/-->/g, '--\\u003E');
      return `<!-- manki-context: ${json} -->`;
    }

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('returns empty priorRounds when no review summary comments exist', async () => {
      const octokit = mockOctokit([], []);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds).toEqual([]);
      expect(state).not.toHaveProperty('lastApprovalAt');
    });

    it('parses HTML-comment context blocks, and finds the last auto-approval', async () => {
      const ctx = makeRoundContext(2);
      const octokit = mockOctokit([], [
        { id: 199, body: `✅ **Approved.** All blocking threads are resolved.\n\n<!-- manki -->\n${AUTO_APPROVE_MARKER}`, user: { login: BOT_LOGIN }, submitted_at: '2026-01-01T01:00:00Z' },
        { id: 200, body: `✅ **Approved.**\n${htmlCommentBlock(ctx)}\n`, user: { login: BOT_LOGIN }, submitted_at: '2026-01-01T02:00:00Z' },
        { id: 201, body: '✅ **Approved.** No change to this PR since the reviewed commit `abc1234`.\n\n<!-- manki-bot -->', user: { login: BOT_LOGIN }, submitted_at: '2026-01-01T03:00:00Z' },
        { id: 202, body: `Quoting it: ${AUTO_APPROVE_MARKER}`, user: { login: 'alice' }, submitted_at: '2026-01-01T04:00:00Z' },
        { id: 203, body: `✅ **Approved.** The finding text echoes ${AUTO_APPROVE_MARKER}\n${htmlCommentBlock(makeRoundContext(3))}`, user: { login: BOT_LOGIN }, submitted_at: '2026-01-01T05:00:00Z' },
        { id: 204, body: `🔴 **Changes requested:** 1 blocker.\n\nThe finding text echoes ${AUTO_APPROVE_MARKER}`, user: { login: BOT_LOGIN }, submitted_at: '2026-01-01T06:00:00Z' },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds.map(r => r.meta.round)).toEqual([2, 3]);
      // A reposted standing verdict, a quote of the marker, and a review that only echoes the marker are not auto-approvals.
      expect(state.lastApprovalAt).toBe('2026-01-01T01:00:00Z');
    });

    it('round-trips findings.entries with specialist, suggestedFix, and title fields', async () => {
      const entry = {
        fingerprint: { file: 'src/foo.ts', lineStart: 10, lineEnd: 12, slug: 'misleading-variable-name' },
        severity: 'warning' as const,
        specialist: 'Correctness',
        suggestedFix: 'Rename `x` to `userCount`.',
        title: 'Misleading variable name',
      };
      const ctx = makeRoundContext(1, {
        findings: { count: 1, severityCounts: { blocker: 0, warning: 1, suggestion: 0, nitpick: 0 }, entries: [entry] },
      });
      const octokit = mockOctokit([], [
        { id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds).toHaveLength(1);
      expect(state.priorRounds[0].findings.entries).toEqual([entry]);
    });

    it('attaches each prior to its Manki thread by marker, file and nearest line', async () => {
      const prior = (file: string, line: number, slug: string, severity: 'warning' | 'blocker' = 'warning') => ({
        fingerprint: { file, lineStart: line, lineEnd: line, slug },
        severity,
        title: slug.replace(/-/g, ' '),
      });
      const entries = [
        prior('src/foo.ts', 10, 'Old-issue', 'blocker'),
        prior('src/foo.ts', 30, 'Other-issue'),
        prior('src/body.ts', 5, 'Old-issue', 'blocker'),
        prior('src/bar.ts', 77, 'File-issue', 'blocker'),
      ];
      const ctx = makeRoundContext(1, {
        findings: { count: 4, severityCounts: { blocker: 3, warning: 1, suggestion: 0, nitpick: 0 }, entries },
      });
      const thread = (id: string, isResolved: boolean, slug: string, originalLine: number) => makeThread({
        id,
        isResolved,
        line: null,
        originalLine,
        comments: { nodes: [{ body: `**Warning**: x\n\n<!-- manki:warning:${slug} -->`, author: { login: BOT_LOGIN } }] },
      });
      const octokit = mockOctokit([
        thread('T_FAR', false, 'Old-issue', 40),
        thread('T_RESOLVED', true, 'Old-issue', 12),
        thread('T_OTHER', false, 'Other-issue', 60),
        makeThread({
          id: 'T_FILE',
          isResolved: true,
          path: 'src/bar.ts',
          line: null,
          originalLine: null,
          comments: { nodes: [{ body: '**Blocker**: x\n\n<!-- manki:blocker:File-issue -->', author: { login: BOT_LOGIN } }] },
        }),
      ], [
        { id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } },
      ]);

      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      const attached = state.priorRounds[0].findings.entries;
      expect(attached.map(e => e.threadId)).toEqual(['T_RESOLVED', undefined, undefined, 'T_FILE']);

      // The resolved threads, line or file-level, retire their blockers. The warning too far from its
      // thread and the body-only blocker on a file the PR no longer changes
      // block nothing either, though thread `T_OTHER` is still open.
      const openThreads = state.previousFindings
        .filter(f => f.status === 'open')
        .map(f => ({ threadId: f.threadId!, title: f.title, file: f.file, line: f.line, severity: f.severity }));
      const { outcome } = determineOutcome([], attached, openThreads, collectResolvedThreadIds(state.previousFindings), undefined, undefined, new Set(['src/foo.ts', 'src/bar.ts']));
      expect(outcome).toBe('READY');
      const unattached = attached.map(({ threadId: _threadId, ...rest }) => rest);
      expect(determineOutcome([], unattached, openThreads, collectResolvedThreadIds(state.previousFindings), undefined, undefined, new Set(['src/foo.ts', 'src/bar.ts'])).outcome).toBe('ADDRESS_FIRST');
    });

    it('matches a blocker posted on a fallback line to its thread by the line its finding data names', async () => {
      const title = 'Auto-approve still approves unread files';
      const slug = titleToSlug(title);
      const entry = { fingerprint: { file: 'src/state.ts', lineStart: 512, lineEnd: 512, slug }, severity: 'blocker' as const, title };
      const ctx = makeRoundContext(12, { findings: { count: 1, severityCounts: { blocker: 1, warning: 0, suggestion: 0, nitpick: 0 }, entries: [entry] } });
      // Line 512 was not in that round's diff, so the thread went on line 1 and only its finding data names 512.
      const data = JSON.stringify({ file: 'src/state.ts', line: 512, severity: 'blocker', title });
      const octokit = mockOctokit([
        makeThread({
          id: 'T_FALLBACK',
          isResolved: true,
          path: 'src/state.ts',
          line: 1,
          originalLine: 1,
          comments: { nodes: [{ body: `\u{1F6AB} **Blocker**: ${title}\n\nDesc.\n\n<!-- manki:blocker:${slug} -->\n<!-- manki-finding: ${data} -->`, author: { login: BOT_LOGIN } }] },
        }),
      ], [{ id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } }]);

      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      const priors = state.priorRounds[0].findings.entries;
      expect(priors.map(e => e.threadId)).toEqual(['T_FALLBACK']);
      expect(state.previousFindings[0]).toMatchObject({ line: 1, findingLine: 512 });
      // The resolved thread backs its blocker, so the next round ends without `prior_unaddressed`.
      const { outcome, verdictReason } = determineOutcome([], priors, [], collectResolvedThreadIds(state.previousFindings), undefined, undefined, new Set(['src/state.ts']));
      expect({ outcome, verdictReason }).toEqual({ outcome: 'READY', verdictReason: 'only_nit_or_suggestion' });
      // A finding raised again on line 512 matches the thread as well, in dedup and in the in-PR suppressions.
      const again = makeFinding({ title, file: 'src/state.ts', line: 512, severity: 'warning' });
      expect(deduplicateFindings([again], state.previousFindings).duplicates).toHaveLength(1);
      expect(collectInPrSuppressions(state.previousFindings).map(s => s.fingerprint)).toEqual([expect.objectContaining({ lineStart: 512, lineEnd: 512 })]);
      // GitHub moves a thread with the code. A normal thread is matched where it sits now, and a thread on a fallback
      // line keeps its gap to the finding's own line.
      const moved = (line: number, originalLine: number, findingLine: number) => ({
        ...state.previousFindings[0], status: 'resolved' as const, line, originalLine, findingLine,
      });
      const at = (line: number) => makeFinding({ title, file: 'src/state.ts', line, severity: 'warning' });
      expect(deduplicateFindings([at(40)], [moved(40, 10, 10)]).duplicates).toHaveLength(1);
      expect(deduplicateFindings([at(10)], [moved(40, 10, 10)]).duplicates).toHaveLength(0);
      expect(deduplicateFindings([at(520)], [moved(9, 1, 512)]).duplicates).toHaveLength(1);
      expect(collectInPrSuppressions([moved(9, 1, 512)]).map(s => s.fingerprint)).toEqual([expect.objectContaining({ lineStart: 520, lineEnd: 520 })]);

      // Without the finding data the thread stays unmatched and the blocker keeps blocking, as before.
      const bare = mockOctokit([
        makeThread({ id: 'T_BARE', isResolved: true, path: 'src/state.ts', line: 1, originalLine: 1, comments: { nodes: [{ body: `**Blocker**: ${title}\n\n<!-- manki:blocker:${slug} -->`, author: { login: BOT_LOGIN } }] } }),
      ], [{ id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } }]);
      const bareState = await fetchRecapState(bare, TEST_BOT, 'owner', 'repo', 1);
      expect(bareState.priorRounds[0].findings.entries.map(e => e.threadId)).toEqual([undefined]);
    });

    it('counts a thread Manki resolved as dismissed only when the judge marked it addressed', async () => {
      const title = 'Missing null check';
      const slug = titleToSlug(title);
      const files = { human: 'src/human.ts', bot: 'src/bot.ts', judge: 'src/judge.ts', unknown: 'src/unknown.ts' };
      const entries = Object.values(files).map(file => ({
        fingerprint: { file, lineStart: 10, lineEnd: 10, slug },
        severity: 'blocker' as const,
        title,
      }));
      const ctx = makeRoundContext(1, {
        findings: { count: 4, severityCounts: { blocker: 4, warning: 0, suggestion: 0, nitpick: 0 }, entries },
        judge: { summary: 'ok', threadEvaluations: [{ threadId: 'T_JUDGE', status: 'addressed', reason: 'fixed' }] },
      });
      const thread = (id: string, path: string, resolver: string | null) => makeThread({
        id,
        isResolved: true,
        resolvedBy: resolver === null ? null : { login: resolver },
        path,
        line: 10,
        comments: { nodes: [{ body: `**Blocker**: ${title}\n\n<!-- manki:blocker:${slug} -->`, author: { login: BOT_LOGIN } }] },
      });
      const octokit = mockOctokit([
        thread('T_HUMAN', files.human, 'alice'),
        thread('T_BOT', files.bot, 'manki-review'),
        thread('T_JUDGE', files.judge, BOT_LOGIN),
        thread('T_UNKNOWN', files.unknown, null),
      ], [
        { id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } },
      ]);

      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.previousFindings.map(f => f.status)).toEqual(['resolved', 'auto-resolved', 'resolved', 'auto-resolved']);
      expect(state.previousFindings.map(f => f.fixed ?? false)).toEqual([false, false, true, false]);

      const newFindings = Object.values(files).map(file => makeFinding({ title, file, line: 10 }));
      const { unique } = deduplicateFindings(newFindings, state.previousFindings);
      expect(unique.map(f => f.file)).toEqual([files.bot, files.judge, files.unknown]);
      expect(unique[1].resemblesFixed).toEqual({ title, file: files.judge, line: 10 });
      expect(collectInPrSuppressions(state.previousFindings).map(s => s.fingerprint.file)).toEqual([files.human]);
      const resolvedThreadIds = collectResolvedThreadIds(state.previousFindings);
      expect(resolvedThreadIds).toEqual(new Set(['T_HUMAN', 'T_JUDGE']));
      const ratcheted = applyCrossRoundSuppression(newFindings, state.priorRounds, { resolvedThreadIds, suppressResolvedThreads: true });
      expect(ratcheted.findings.filter(f => f.severity !== 'ignore').map(f => f.file)).toEqual([files.bot, files.unknown]);

      const judgePrior = state.priorRounds[0].findings.entries.filter(e => e.threadId === 'T_JUDGE');
      expect(judgePrior).toHaveLength(1);
      expect(determineOutcome([], judgePrior, [], resolvedThreadIds).outcome).toBe('READY');
    });

    it('keeps a blocking or security finding blocking until someone other than the PR author dismisses it', async () => {
      const title = 'Token leaks into logs';
      const slug = titleToSlug(title);
      type Case = { resolver?: string; reply?: { login: string; association: string; text?: string }; reopened?: boolean; dismissed?: boolean; security: boolean; blocker?: boolean; blocks: boolean };
      const cases: Record<string, Case> = {
        'src/author-resolved.ts': { resolver: 'author', security: true, blocks: true },
        // A recorded override counts only once the PR author passes the admin check, since a Manki reply can echo any text.
        'src/admin-dismissed.ts': { resolver: BOT_LOGIN, dismissed: true, security: true, blocks: true },
        'src/bot-resolved.ts': { resolver: BOT_LOGIN, security: true, blocks: true },
        'src/author-resolved-again.ts': { resolver: 'author', reopened: true, security: true, blocks: true },
        'src/author-agreed.ts': { reply: { login: 'author', association: 'OWNER' }, security: true, blocks: true },
        'src/outsider-agreed.ts': { reply: { login: 'carol', association: 'CONTRIBUTOR' }, security: true, blocks: true },
        'src/collaborator-resolved.ts': { resolver: 'alice', security: true, blocks: false },
        'src/collaborator-agreed.ts': { reply: { login: 'bob', association: 'MEMBER' }, security: true, blocks: false },
        'src/collaborator-dismissed.ts': { resolver: BOT_LOGIN, reply: { login: 'bob', association: 'MEMBER', text: '@manki dismiss' }, security: true, blocks: false },
        // `MEMBER` covers an org member with read access, so write access comes from the API.
        'src/reader-agreed.ts': { reply: { login: 'dave', association: 'MEMBER' }, security: true, blocks: true },
        // A private org member shows as `NONE`.
        'src/private-member-agreed.ts': { reply: { login: 'erin', association: 'NONE' }, security: true, blocks: false },
        'src/judge-addressed.ts': { resolver: 'author', security: true, blocks: false },
        'src/plain-author-resolved.ts': { resolver: 'author', security: false, blocks: false },
        'src/plain-author-agreed.ts': { reply: { login: 'author', association: 'NONE' }, security: false, blocks: false },
        'src/blocker-author-resolved.ts': { resolver: 'author', security: false, blocker: true, blocks: true },
        'src/blocker-author-agreed.ts': { reply: { login: 'author', association: 'OWNER' }, security: false, blocker: true, blocks: true },
        'src/blocker-collaborator-resolved.ts': { resolver: 'alice', security: false, blocker: true, blocks: false },
      };
      const severity = (file: string) => cases[file].security || cases[file].blocker ? 'blocker' as const : 'warning' as const;
      const files = Object.keys(cases);
      const ctx = makeRoundContext(1, {
        findings: {
          count: files.length,
          severityCounts: { blocker: 11, warning: 2, suggestion: 0, nitpick: 0 },
          entries: files.map(file => ({
            fingerprint: { file, lineStart: 10, lineEnd: 10, slug },
            severity: severity(file),
            title,
            ...(cases[file].security && { tags: ['security'] }),
          })),
        },
        judge: { summary: 'ok', threadEvaluations: [{ threadId: 'T_src/judge-addressed.ts', status: 'addressed', reason: 'The token is redacted now.' }] },
      });
      const octokit = mockOctokit(files.map(file => {
        const { resolver, reply, reopened, dismissed, security } = cases[file];
        const body = formatFindingComment(makeFinding({
          severity: severity(file), title, file, line: 10, ...(security && { tags: ['security'] }),
        }), TEST_LINKS);
        return makeThread({
          id: `T_${file}`,
          isResolved: !!resolver,
          resolvedBy: resolver ? { login: resolver } : null,
          path: file,
          line: 10,
          comments: { nodes: [
            { body, author: { login: BOT_LOGIN } },
            ...(reopened ? [{ body: `<!-- manki -->\n${REOPENED_MARKER}\nReopened.`, author: { login: BOT_LOGIN } }] : []),
            ...(dismissed ? [{ body: `Dismissed.\n<!-- manki -->\n${securityOverrideMarker('dismiss', 'author')}`, author: { login: BOT_LOGIN } }] : []),
            ...(reply ? [{ body: reply.text ?? 'Agreed, no change needed.', author: { login: reply.login }, authorAssociation: reply.association }] : []),
          ] },
        });
      }), [{ id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } }]);
      const permissions: Record<string, string> = { author: 'write', bob: 'write', dave: 'read', erin: 'write' };
      const permission = jest.fn(async ({ username }: { username: string }) => ({ data: { permission: permissions[username] ?? 'none' } }));
      Object.assign(octokit.rest, { repos: { getCollaboratorPermissionLevel: permission } });

      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1, 'author');
      expect(state.previousFindings.filter(f => f.reopen).map(f => f.file)).toEqual(['src/author-resolved.ts', 'src/blocker-author-resolved.ts']);
      expect(state.previousFindings.filter(f => f.securityOverride)).toEqual([]);
      const openThreads = state.previousFindings
        .filter(f => f.status === 'open' || f.status === 'replied')
        .map(f => ({ threadId: f.threadId!, title: f.title, file: f.file, line: f.line, severity: f.severity }));
      const resolvedThreadIds = collectResolvedThreadIds(state.previousFindings);
      const blocking = state.priorRounds[0].findings.entries
        .filter(e => determineOutcome([], [e], openThreads, resolvedThreadIds).outcome === 'ADDRESS_FIRST')
        .map(e => e.fingerprint.file);
      expect(blocking).toEqual(files.filter(file => cases[file].blocks));

      const reRaised = files.map(file => makeFinding({ severity: 'blocker', title, file, line: 10 }));
      expect(collectInPrSuppressions(state.previousFindings, 'author').map(s => s.fingerprint.file))
        .toEqual(files.filter(file => !cases[file].blocks && file !== 'src/judge-addressed.ts'));
      // Dedup drops a blocker only on a resolved blocking or security thread not confirmed fixed. An agreed thread is dropped by the in-PR suppressions above.
      expect(deduplicateFindings(reRaised, state.previousFindings).unique.map(f => f.file))
        .toEqual(files.filter(file => cases[file].blocks || cases[file].reply || severity(file) === 'warning' || file === 'src/judge-addressed.ts'));

      // With the PR author unknown, any human resolver has write access, so a human resolution clears the thread.
      const unknownAuthor = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(unknownAuthor.previousFindings.filter(f => f.isSecurity && f.status === 'resolved').map(f => f.file))
        .toEqual(['src/author-resolved.ts', 'src/author-resolved-again.ts', 'src/collaborator-resolved.ts', 'src/judge-addressed.ts']);

      // A reply from someone with write access agrees a security thread away under the same fallback.
      expect(collectInPrSuppressions(unknownAuthor.previousFindings).filter(s => s.reason === 'agree-reply').map(s => s.fingerprint.file))
        .toEqual(['src/author-agreed.ts', 'src/collaborator-agreed.ts', 'src/collaborator-dismissed.ts', 'src/private-member-agreed.ts', 'src/blocker-author-agreed.ts']);

      // A repo admin author clears their own resolved threads. Nothing is reopened, and the override waits for Manki's reply.
      // Permissions are cached per client, so the admin check needs a fresh one.
      permissions.author = 'admin';
      const admin = Object.create(octokit);
      const adminState = await fetchRecapState(admin, TEST_BOT, 'owner', 'repo', 1, 'author');
      expect(adminState.previousFindings.filter(f => f.reopen)).toEqual([]);
      expect(adminState.previousFindings.filter(f => f.securityOverride).map(f => [f.file, f.securityOverride])).toEqual([
        ['src/author-resolved.ts', { login: 'author', via: 'resolve', announced: false }],
        ['src/admin-dismissed.ts', { login: 'author', via: 'dismiss', announced: true }],
        ['src/author-resolved-again.ts', { login: 'author', via: 'resolve', announced: false }],
        ['src/blocker-author-resolved.ts', { login: 'author', via: 'resolve', announced: false }],
      ]);
      const adminOpen = adminState.previousFindings.filter(f => f.status === 'open' || f.status === 'replied')
        .map(f => ({ threadId: f.threadId!, title: f.title, file: f.file, line: f.line, severity: f.severity }));
      expect(adminState.priorRounds[0].findings.entries
        .filter(e => determineOutcome([], [e], adminOpen, collectResolvedThreadIds(adminState.previousFindings)).outcome === 'ADDRESS_FIRST')
        .map(e => e.fingerprint.file))
        .toEqual(files.filter(file => cases[file].blocks && !['src/author-resolved.ts', 'src/admin-dismissed.ts', 'src/author-resolved-again.ts', 'src/blocker-author-resolved.ts'].includes(file)));
      // A second read on the same client does not ask GitHub again.
      const lookups = permission.mock.calls.length;
      await fetchRecapState(admin, TEST_BOT, 'owner', 'repo', 1, 'author');
      expect(permission).toHaveBeenCalledTimes(lookups);
      expect(permission).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', username: 'author' });
    });

    it('round-trips suggestedFix containing a literal \\u0060 escape sequence without parse error', async () => {
      // Regression: suggestedFix containing a regex like /`/g (literal backslash + u0060)
      // was stored as \\u0060 in the JSON, which the old parser's naive .replace(/\\u0060/g, '`')
      // turned into \\` — an invalid JSON escape sequence.
      const entry = {
        fingerprint: { file: 'src/recap.ts', lineStart: 201, lineEnd: 201, slug: 'backtick-unescape' },
        severity: 'warning' as const,
        specialist: 'Correctness',
        suggestedFix: "candidates.push(m[1].replace(/\\u0060/g, '`'));",
        title: 'Parser unescapes \\u0060 incorrectly',
      };
      const ctx = makeRoundContext(1, {
        findings: { count: 1, severityCounts: { blocker: 0, warning: 1, suggestion: 0, nitpick: 0 }, entries: [entry] },
      });
      const octokit = mockOctokit([], [
        { id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds).toHaveLength(1);
      expect(state.priorRounds[0].findings.entries[0].suggestedFix).toBe(entry.suggestedFix);
    });

    it('round-trips findings.entries through the HTML-comment wrapper', async () => {
      const entry = {
        fingerprint: { file: 'src/bar.ts', lineStart: 5, lineEnd: 5, slug: 'unused-import' },
        severity: 'nitpick' as const,
        specialist: 'Style',
        suggestedFix: 'Remove the unused `path` import.',
        title: 'Unused import',
      };
      const ctx = makeRoundContext(2, {
        findings: { count: 1, severityCounts: { blocker: 0, warning: 0, suggestion: 0, nitpick: 1 }, entries: [entry] },
      });
      const octokit = mockOctokit([], [
        { id: 200, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds[0].findings.entries[0].specialist).toBe('Style');
      expect(state.priorRounds[0].findings.entries[0].suggestedFix).toBe('Remove the unused `path` import.');
      expect(state.priorRounds[0].findings.entries[0].title).toBe('Unused import');
    });

    it('sorts multiple rounds chronologically by meta.round', async () => {
      const c3 = makeRoundContext(3);
      const c1 = makeRoundContext(1);
      const c2 = makeRoundContext(2);
      const octokit = mockOctokit([], [
        { id: 11, body: htmlCommentBlock(c3), user: { login: BOT_LOGIN } },
        { id: 12, body: htmlCommentBlock(c1), user: { login: BOT_LOGIN } },
        { id: 13, body: htmlCommentBlock(c2), user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds.map(r => r.meta.round)).toEqual([1, 2, 3]);
    });

    it('skips a review with malformed JSON and emits core.warning', async () => {
      const malformed = '<!-- manki-context: {not valid json} -->';
      const octokit = mockOctokit([], [
        { id: 500, body: malformed, user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds).toEqual([]);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('https://github.com/owner/repo/pull/1#pullrequestreview-500'),
      );
    });

    it('skips a review missing required meta.round and emits core.warning', async () => {
      const badJson = JSON.stringify({ meta: { mankiVersion: '4.7.0' }, verdict: 'COMMENT' });
      const body = `<!-- manki-context: ${badJson} -->`;
      const octokit = mockOctokit([], [
        { id: 600, body, user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds).toEqual([]);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('meta.round'),
      );
    });

    it('dedupes duplicate meta.round, picking the higher review id, and warns', async () => {
      const earlier = makeRoundContext(1, { judge: { summary: 'first attempt' } });
      const later = makeRoundContext(1, { judge: { summary: 'final version' } });
      const octokit = mockOctokit([], [
        { id: 10, body: htmlCommentBlock(earlier), user: { login: BOT_LOGIN } },
        { id: 20, body: htmlCommentBlock(later), user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds).toHaveLength(1);
      expect(state.priorRounds[0].judge.summary).toBe('final version');
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate Manki context blocks for round 1'),
      );
    });

    it('skips a context block whose parsed value is null (not an object)', async () => {
      const body = '<!-- manki-context: null -->';
      const octokit = mockOctokit([], [
        { id: 700, body, user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds).toEqual([]);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('not an object'),
      );
    });

    it('skips a context block whose meta is not an object', async () => {
      const badJson = JSON.stringify({ meta: 'not-an-object', verdict: 'COMMENT' });
      const body = `<!-- manki-context: ${badJson} -->`;
      const octokit = mockOctokit([], [
        { id: 800, body, user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds).toEqual([]);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('missing meta'),
      );
    });

    it('skips a context block missing meta.mankiVersion', async () => {
      const badJson = JSON.stringify({ meta: { round: 1 }, verdict: 'COMMENT' });
      const body = `<!-- manki-context: ${badJson} -->`;
      const octokit = mockOctokit([], [
        { id: 900, body, user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds).toEqual([]);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('meta.mankiVersion'),
      );
    });

    it('returns empty priorRounds and warns when listReviews throws', async () => {
      const octokit = {
        graphql: jest.fn().mockResolvedValue({
          repository: {
            pullRequest: {
              reviewThreads: { pageInfo: LAST_PAGE, nodes: [] },
            },
          },
        }),
        paginate: jest.fn(paginateSinglePage),
        rest: {
          pulls: {
            listReviews: jest.fn().mockRejectedValue(new Error('API unavailable')),
          },
        },
      } as unknown as ReturnType<typeof import('@actions/github').getOctokit>;
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds).toEqual([]);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch prior round contexts'),
      );
    });

    it('skips a block when a non-SyntaxError is thrown from JSON.parse and emits core.warning', async () => {
      const sentinel = '"__sentinel_throw__"';
      const body = `<!-- manki-context: ${sentinel} -->`;
      const octokit = mockOctokit([], [
        { id: 999, body, user: { login: BOT_LOGIN } },
      ]);
      const original = JSON.parse.bind(JSON);
      const spy = jest.spyOn(JSON, 'parse').mockImplementation((text: string) => {
        if (text.trim() === sentinel) throw new TypeError('unexpected mock error');
        return original(text);
      });
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      spy.mockRestore();
      expect(state.priorRounds).toEqual([]);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('https://github.com/owner/repo/pull/1#pullrequestreview-999'),
      );
    });

    it('reads context only from reviews by the bot identity', async () => {
      const octokit = mockOctokit([], [
        { id: 100, body: htmlCommentBlock(makeRoundContext(1)), user: { login: 'some-user' } },
        { id: 101, body: htmlCommentBlock(makeRoundContext(2)), user: { login: 'manki-review[bot]' } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds.map(r => r.meta.round)).toEqual([2]);
      const customApp = await fetchRecapState(octokit, { logins: ['acme-reviewer[bot]'] }, 'owner', 'repo', 1);
      expect(customApp.priorRounds).toEqual([]);
    });

    it('skips malformed JSON block but still loads subsequent valid blocks', async () => {
      const ctx3 = makeRoundContext(3);
      const malformed = '<!-- manki-context: {bad} -->';
      const octokit = mockOctokit([], [
        { id: 500, body: malformed, user: { login: BOT_LOGIN } },
        { id: 501, body: htmlCommentBlock(ctx3), user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds).toHaveLength(1);
      expect(state.priorRounds[0].meta.round).toBe(3);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('https://github.com/owner/repo/pull/1#pullrequestreview-500'),
      );
    });

    it('round-trips a field containing backticks through the details wrapper', async () => {
      const ctx = makeRoundContext(9, { judge: { summary: 'use `foo()` here' } });
      const octokit = mockOctokit([], [
        { id: 400, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds).toHaveLength(1);
      expect(state.priorRounds[0].judge.summary).toBe('use `foo()` here');
    });

    it('round-trips a field containing --> through the HTML-comment wrapper', async () => {
      const ctx = makeRoundContext(1, { judge: { summary: 'Verdict --> pass' } });
      const octokit = mockOctokit([], [
        { id: 300, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds).toHaveLength(1);
      expect(state.priorRounds[0].judge.summary).toBe('Verdict --> pass');
    });

    it('reads context from every page of reviews', async () => {
      const reviews = Array.from({ length: 150 }, (_, i) => ({
        id: i + 1,
        body: htmlCommentBlock(makeRoundContext(i + 1)),
        user: { login: BOT_LOGIN },
      }));
      const octokit = mockOctokit([], reviews.slice(0, 100));
      jest.mocked(octokit.paginate).mockResolvedValueOnce(reviews);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(octokit.paginate).toHaveBeenCalledWith(octokit.rest.pulls.listReviews, expect.objectContaining({ per_page: 100 }));
      expect(state.priorRounds).toHaveLength(150);
      expect(core.warning).not.toHaveBeenCalled();
    });

    it('re-derives authorReplyClass from current thread state, overriding the stale emit-time cache', async () => {
      const ctx = makeRoundContext(1, {
        findings: {
          count: 1,
          severityCounts: { warning: 1 },
          entries: [{
            fingerprint: { file: 'src/foo.ts', lineStart: 10, lineEnd: 10, slug: 'Null-check' },
            severity: 'warning',
            threadId: 'thread-1',
            authorReplyClass: 'none',
            title: 'Null check',
          }],
        },
      });
      const thread = makeThread({
        id: 'thread-1',
        comments: {
          nodes: [
            { body: '<!-- manki:warning:Null-check --> **Warning**: Null check\n\nDescription.', author: { login: 'manki-review[bot]' } },
            { body: 'Fixed in latest push', author: { login: 'author' } },
          ],
        },
      });
      const octokit = mockOctokit([thread], [
        { id: 200, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds[0].findings.entries[0].authorReplyClass).toBe('agree');
    });

    it('re-derives authorReplyClass via slug+file fallback when entry has no threadId', async () => {
      const ctx = makeRoundContext(1, {
        findings: {
          count: 1,
          severityCounts: { warning: 1 },
          entries: [{
            fingerprint: { file: 'src/foo.ts', lineStart: 10, lineEnd: 10, slug: 'Null-check' },
            severity: 'warning',
            authorReplyClass: 'none',
            title: 'Null check',
          }],
        },
      });
      const thread = makeThread({
        id: undefined,
        comments: {
          nodes: [
            { body: '<!-- manki:warning:Null-check --> ⚠️ **Warning**: Null check\n\nDescription.', author: { login: 'manki-review[bot]' } },
            { body: 'Agreed, will fix', author: { login: 'author' } },
          ],
        },
      });
      const octokit = mockOctokit([thread], [
        { id: 200, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds[0].findings.entries[0].authorReplyClass).toBe('agree');
    });

    it('leaves authorReplyClass unchanged when entry has no threadId and no slug+file match', async () => {
      const ctx = makeRoundContext(1, {
        findings: {
          count: 1,
          severityCounts: { warning: 1 },
          entries: [{
            fingerprint: { file: 'src/foo.ts', lineStart: 10, lineEnd: 10, slug: 'Null-check' },
            severity: 'warning',
            authorReplyClass: 'none',
            title: 'Null check',
          }],
        },
      });
      const octokit = mockOctokit([], [
        { id: 200, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds[0].findings.entries[0].authorReplyClass).toBe('none');
    });

    it('leaves authorReplyClass unchanged when threadId present but not found in live threads', async () => {
      const ctx = makeRoundContext(1, {
        findings: {
          count: 1,
          severityCounts: { warning: 1 },
          entries: [{
            fingerprint: { file: 'src/foo.ts', lineStart: 10, lineEnd: 10, slug: 'Null-check' },
            severity: 'warning',
            threadId: 'unknown-thread',
            authorReplyClass: 'none',
            title: 'Null check',
          }],
        },
      });
      const octokit = mockOctokit([], [
        { id: 200, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds[0].findings.entries[0].authorReplyClass).toBe('none');
    });

    it('re-classifies to disagree when author reply signals disagreement', async () => {
      const ctx = makeRoundContext(1, {
        findings: {
          count: 1,
          severityCounts: { blocker: 1 },
          entries: [{
            fingerprint: { file: 'src/foo.ts', lineStart: 10, lineEnd: 10, slug: 'Null-check' },
            severity: 'blocker',
            threadId: 'thread-disagree',
            authorReplyClass: 'none',
            title: 'Null check',
          }],
        },
      });
      const thread = makeThread({
        id: 'thread-disagree',
        comments: {
          nodes: [
            { body: '<!-- manki:blocker:Null-check --> \u{1F6AB} **Blocker**: Null check\n\nDescription.', author: { login: 'manki-review[bot]' } },
            { body: 'I disagree with this finding, the code is correct', author: { login: 'author' } },
          ],
        },
      });
      const octokit = mockOctokit([thread], [
        { id: 200, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds[0].findings.entries[0].authorReplyClass).toBe('disagree');
    });

    it('records reclassified-prior count and attribution when authorReplyClass flips', async () => {
      const ctx = makeRoundContext(1, {
        findings: {
          count: 2,
          severityCounts: { warning: 2 },
          entries: [
            {
              fingerprint: { file: 'src/foo.ts', lineStart: 10, lineEnd: 10, slug: 'Null-check' },
              severity: 'warning',
              threadId: 'thread-agree',
              authorReplyClass: 'none',
              title: 'Null check',
            },
            {
              fingerprint: { file: 'src/bar.ts', lineStart: 20, lineEnd: 20, slug: 'Other' },
              severity: 'warning',
              threadId: 'thread-no-change',
              authorReplyClass: 'none',
              title: 'Other',
            },
          ],
        },
      });
      const threadAgree = makeThread({
        id: 'thread-agree',
        comments: {
          nodes: [
            { body: '<!-- manki:warning:Null-check --> **Warning**: Null check', author: { login: 'manki-review[bot]' } },
            { body: 'Agreed, will fix', author: { login: 'author' } },
          ],
        },
      });
      const threadNoChange = makeThread({
        id: 'thread-no-change',
        comments: {
          nodes: [
            { body: '<!-- manki:warning:Other --> **Warning**: Other', author: { login: 'manki-review[bot]' } },
          ],
        },
      });
      const octokit = mockOctokit([threadAgree, threadNoChange], [
        { id: 200, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.reclassifiedPriorCount).toBe(1);
      expect(state.reclassifiedPriors).toEqual([{ threadId: 'thread-agree', from: 'none', to: 'agree' }]);
    });

    it('counts slug-file fallback flips but omits them from attribution (no threadId)', async () => {
      const ctx = makeRoundContext(1, {
        findings: {
          count: 1,
          severityCounts: { warning: 1 },
          entries: [{
            fingerprint: { file: 'src/foo.ts', lineStart: 10, lineEnd: 10, slug: 'Null-check' },
            severity: 'warning',
            authorReplyClass: 'none',
            title: 'Null check',
          }],
        },
      });
      const thread = makeThread({
        id: undefined,
        path: 'src/foo.ts',
        line: 10,
        comments: {
          nodes: [
            { body: '<!-- manki:warning:Null-check --> **Warning**: Null check', author: { login: 'manki-review[bot]' } },
            { body: 'Agreed, will fix', author: { login: 'author' } },
          ],
        },
      });
      const octokit = mockOctokit([thread], [
        { id: 200, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.reclassifiedPriorCount).toBe(1);
      expect(state.reclassifiedPriors).toEqual([]);
    });

    it('returns zero reclassified count when no priors exist', async () => {
      const octokit = mockOctokit([], []);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.reclassifiedPriorCount).toBe(0);
      expect(state.reclassifiedPriors).toEqual([]);
    });
  });
});

describe('collectInPrSuppressions', () => {
  it('suppresses resolved threads regardless of reply', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Missing null check', file: 'src/a.ts', line: 10, status: 'resolved' }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('resolved-thread');
    expect(result[0].fingerprint).toEqual({
      file: 'src/a.ts',
      lineStart: 10,
      lineEnd: 10,
      slug: titleToSlug('Missing null check'),
    });
    expect(collectInPrSuppressions([makePrevious({ title: 'Missing null check', file: 'src/a.ts', line: 10, status: 'resolved', fixed: true })])).toEqual([]);
  });

  // Note: `fetchReviewThreads` always classifies a thread with at least one
  // non-bot reply as `replied`, so a PreviousFinding with `status: 'open'`
  // and a non-empty `authorReplyText` is not produced today. The `open+...`
  // cases below pin that `inPrSuppressionReasonFor` is status-agnostic for
  // the agree-reply branch (the gate is login + classification, not status),
  // so the same logic continues to apply if the status taxonomy ever changes.
  // The realistic production cases are covered by the `replied+...` tests.
  it('suppresses open threads whose latest author reply is agree from PR author', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Unused var', file: 'src/a.ts', line: 10, status: 'open', authorReplyText: 'Fixed, thanks!', authorReplyLogin: 'pr-author' }),
    ], 'pr-author');
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('agree-reply');
    expect(result[0].authorLogin).toBe('pr-author');
  });

  it('suppresses replied threads whose author reply is agree from PR author', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Null check', file: 'src/a.ts', line: 10, status: 'replied', authorReplyText: 'Fixed, done.', authorReplyLogin: 'pr-author' }),
    ], 'pr-author');
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('agree-reply');
    expect(result[0].authorLogin).toBe('pr-author');
  });

  it('does not suppress agree-reply from a third-party commenter (different login than PR author)', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Unused var', file: 'src/a.ts', line: 10, status: 'open', authorReplyText: 'Fixed!', authorReplyLogin: 'random-user' }),
    ], 'pr-author');
    expect(result).toHaveLength(0);
  });

  it('does not suppress agree-reply when prAuthorLogin is undefined', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Unused var', file: 'src/a.ts', line: 10, status: 'open', authorReplyText: 'Fixed!', authorReplyLogin: 'pr-author' }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('still suppresses resolved threads even when reply login does not match PR author', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Resolved by maintainer', file: 'src/a.ts', line: 10, status: 'resolved', authorReplyLogin: 'maintainer' }),
    ], 'pr-author');
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('resolved-thread');
    expect(result[0].authorLogin).toBeUndefined();
  });

  it('does not suppress open threads whose author reply is disagree', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Unused var', file: 'src/a.ts', line: 10, status: 'open', authorReplyText: 'I disagree, this is intentional.', authorReplyLogin: 'pr-author' }),
    ], 'pr-author');
    expect(result).toHaveLength(0);
  });

  it('does not suppress replied threads whose author reply is partial', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Unused var', file: 'src/a.ts', line: 10, status: 'replied', authorReplyText: 'Still working on it.', authorReplyLogin: 'pr-author' }),
    ], 'pr-author');
    expect(result).toHaveLength(0);
  });

  it('does not suppress open threads whose author reply is partial', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Unused var', file: 'src/a.ts', line: 10, status: 'open', authorReplyText: 'Working on it.', authorReplyLogin: 'pr-author' }),
    ], 'pr-author');
    expect(result).toHaveLength(0);
  });

  it('does not suppress open threads with no author reply', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Unused var', file: 'src/a.ts', line: 10, status: 'open' }),
    ], 'pr-author');
    expect(result).toHaveLength(0);
  });

  it('does not suppress replied threads with no author reply', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Some issue', file: 'src/a.ts', line: 10, status: 'replied' }),
    ], 'pr-author');
    expect(result).toHaveLength(0);
  });

  it('skips file-level threads with no line anchor (line is 0 or null)', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'File-level note', file: 'src/a.ts', line: 0, status: 'resolved' }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('skips threads missing a parseable title', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: '', file: 'src/a.ts', line: 10, status: 'resolved' }),
      makePrevious({ title: 'AB', file: 'src/a.ts', line: 11, status: 'resolved' }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('uses lineStart when present for multi-line annotations', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Range issue', file: 'src/a.ts', line: 44, lineStart: 40, status: 'resolved' }),
    ]);
    expect(result[0].fingerprint.lineStart).toBe(40);
    expect(result[0].fingerprint.lineEnd).toBe(44);
  });

  it('collects a mix of resolved and agree-reply reasons in one pass', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Resolved finding', file: 'f.ts', line: 1, status: 'resolved' }),
      makePrevious({ title: 'Agreed finding', file: 'f.ts', line: 2, status: 'open', authorReplyText: 'addressed in a1b2c3d', authorReplyLogin: 'pr-author' }),
      makePrevious({ title: 'Kept finding', file: 'f.ts', line: 3, status: 'open', authorReplyText: "no, keeping it", authorReplyLogin: 'pr-author' }),
    ], 'pr-author');
    expect(result.map(r => r.reason)).toEqual(['resolved-thread', 'agree-reply']);
  });
});

describe('llmDeduplicateFindings', () => {
  it('returns all findings when no dismissed findings exist', async () => {
    const findings = [makeFinding({ title: 'Null check missing', file: 'src/foo.ts', line: 10 })];
    const previous = [makePrevious({ status: 'open' })];
    const mockClient = { sendMessage: jest.fn() } as unknown as import('./providers').LLMClient;

    const result = await llmDeduplicateFindings(findings, previous, mockClient);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it('returns all findings when no findings to check', async () => {
    const previous = [makePrevious({ status: 'resolved' })];
    const mockClient = { sendMessage: jest.fn() } as unknown as import('./providers').LLMClient;

    const result = await llmDeduplicateFindings([], previous, mockClient);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it('identifies LLM-matched duplicates', async () => {
    const findings = [
      makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 10 }),
      makeFinding({ title: 'Unused import', file: 'src/bar.ts', line: 5 }),
    ];
    const previous = [
      makePrevious({ title: 'Null safety issue', file: 'src/foo.ts', line: 10, status: 'resolved' }),
    ];
    const mockClient = {
      sendMessage: jest.fn().mockResolvedValue({
        content: '[{ "index": 1, "matchedDismissed": 1 }]',
      }),
    } as unknown as import('./providers').LLMClient;

    const result = await llmDeduplicateFindings(findings, previous, mockClient);
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0].title).toBe('Unused import');
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].finding.title).toBe('Missing null check');
    expect(result.duplicates[0].matchedTitle).toBe('Null safety issue');
    expect(result.duplicates[0].matchType).toBe('llm');

    const fixed = makePrevious({ ...previous[0], fixed: true });
    const kept = await llmDeduplicateFindings(findings, [fixed], mockClient);
    expect(kept.duplicates).toHaveLength(0);
    expect(kept.unique).toEqual([{ ...findings[0], resemblesFixed: { title: 'Null safety issue', file: 'src/foo.ts', line: 10 } }, findings[1]]);
    jest.mocked(mockClient.sendMessage).mockResolvedValueOnce({ content: '[{ "index": 1, "matchedDismissed": 1 }, { "index": 1, "matchedDismissed": 2 }]' } as never);
    const both = await llmDeduplicateFindings(findings, [fixed, previous[0]], mockClient);
    expect(both.duplicates.map(d => d.finding.title)).toEqual(['Missing null check']);

    // A blocker is dropped only for a resolved blocking or security thread, since the PR author can resolve any other.
    const blocker = { ...findings[0], severity: 'blocker' as const };
    const notWaived = await llmDeduplicateFindings([blocker], previous, mockClient);
    expect(notWaived).toEqual({ unique: [blocker], duplicates: [] });
    for (const guarded of [{ severity: 'blocker' as const }, { isSecurity: true }]) {
      const waived = await llmDeduplicateFindings([blocker], [makePrevious({ ...previous[0], ...guarded })], mockClient);
      expect(waived.duplicates.map(d => d.finding.title)).toEqual(['Missing null check']);
    }
  });

  it('handles LLM returning no matches', async () => {
    const findings = [
      makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 10 }),
    ];
    const previous = [
      makePrevious({ title: 'Unused variable', file: 'src/bar.ts', line: 20, status: 'resolved' }),
    ];
    const mockClient = {
      sendMessage: jest.fn().mockResolvedValue({ content: '[]' }),
    } as unknown as import('./providers').LLMClient;

    const result = await llmDeduplicateFindings(findings, previous, mockClient);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });

  it('gracefully handles LLM errors', async () => {
    const findings = [
      makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 10 }),
    ];
    const previous = [
      makePrevious({ title: 'Old finding', file: 'src/foo.ts', line: 10, status: 'resolved' }),
    ];
    const mockClient = {
      sendMessage: jest.fn().mockRejectedValue(new Error('API error')),
    } as unknown as import('./providers').LLMClient;

    const result = await llmDeduplicateFindings(findings, previous, mockClient);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });

  it('does not treat replied findings as dismissed', async () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 10 })];
    const previous = [makePrevious({ title: 'Missing null check', status: 'replied' })];
    const mockClient = { sendMessage: jest.fn() } as unknown as import('./providers').LLMClient;

    const result = await llmDeduplicateFindings(findings, previous, mockClient);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it('handles LLM response with code fences', async () => {
    const findings = [
      makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 10 }),
      makeFinding({ title: 'Unused import', file: 'src/bar.ts', line: 5 }),
    ];
    const previous = [
      makePrevious({ title: 'Null safety issue', file: 'src/foo.ts', line: 10, status: 'resolved' }),
    ];
    const mockClient = {
      sendMessage: jest.fn().mockResolvedValue({
        content: '```json\n[{ "index": 1, "matchedDismissed": 1 }]\n```',
      }),
    } as unknown as import('./providers').LLMClient;

    const result = await llmDeduplicateFindings(findings, previous, mockClient);
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0].title).toBe('Unused import');
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].finding.title).toBe('Missing null check');
    expect(result.duplicates[0].matchedTitle).toBe('Null safety issue');
  });

  it('keeps finding in unique when matchedDismissed index is out of bounds', async () => {
    const findings = [
      makeFinding({ title: 'Null check missing', file: 'src/foo.ts', line: 10 }),
    ];
    const previous = [
      makePrevious({ title: 'Old issue A', file: 'src/a.ts', line: 1, status: 'resolved' }),
      makePrevious({ title: 'Old issue B', file: 'src/b.ts', line: 2, status: 'resolved' }),
    ];
    const mockClient = {
      sendMessage: jest.fn().mockResolvedValue({
        content: '[{ "index": 1, "matchedDismissed": 99 }]',
      }),
    } as unknown as import('./providers').LLMClient;

    const result = await llmDeduplicateFindings(findings, previous, mockClient);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });
});

const makeCommentBody = (description: string, aiContextJson?: string): string => {
  const ai = aiContextJson
    ? `\n<details>\n<summary>AI context</summary>\n\n\`\`\`json\n${aiContextJson}\n\`\`\`\n</details>`
    : '';
  return `🟠 ✨ **Suggestion**: Title text\n\n${description}\n\n<details>\n<summary>Suggested fix</summary>\n\n\`\`\`suggestion\nsome fix\n\`\`\`\n</details>${ai}\n\n<!-- manki:suggestion:Title-text -->`;
};

describe('parseFindingFromComment', () => {
  it('extracts the description of a not-blocking, low-confidence comment from `formatFindingComment`', () => {
    const body = formatFindingComment({ severity: 'suggestion', title: 'Extract helper', file: 'src/a.ts', line: 2, description: 'The logic is duplicated.', reviewers: [], judgeConfidence: 'low' }, TEST_LINKS);
    expect(parseFindingFromComment(body)).toEqual({ description: 'The logic is duplicated.', suggestedFix: undefined });
    const toolBody = formatFindingComment({ severity: 'warning', title: 'js/sql-injection: Query built from user input', file: 'src/a.ts', line: 2, description: 'The query uses `name`.', reviewers: ['CodeQL'], toolSource: 'CodeQL (1.2)', category: 'security', effort: 'quick' }, TEST_LINKS);
    expect(parseFindingFromComment(toolBody)).toEqual({ description: 'The query uses `name`.', suggestedFix: undefined });
  });

  it('extracts description up to the <details> stop marker', () => {
    const body = makeCommentBody('The variable is never checked for null.');
    const result = parseFindingFromComment(body);
    expect(result.description).toBe('The variable is never checked for null.');
  });

  it('extracts description truncated by code-fence stop marker and appends truncation marker', () => {
    const body = `🟠 ✨ **Suggestion**: Title\n\nDescription with\n\`\`\`code\nexample\n\`\`\`\nmore text\n\n<!-- manki:suggestion:Title -->`;
    const result = parseFindingFromComment(body);
    expect(result.description).toBe('Description with…(truncated)');
  });

  it('extracts description terminated by <!-- manki: stop marker without truncation marker', () => {
    const body = `🟠 ✨ **Suggestion**: Title\n\nSome description\n<!-- manki:suggestion:Title -->`;
    const result = parseFindingFromComment(body);
    expect(result.description).toBe('Some description');
  });

  it('extracts suggestedFix from AI context JSON', () => {
    const body = makeCommentBody('Desc.', '{"fix":"Add null check before access","severity":"suggestion","confidence":"high","flaggedBy":["Correctness"]}');
    const result = parseFindingFromComment(body);
    expect(result.suggestedFix).toBe('Add null check before access');
  });

  it('returns undefined suggestedFix for malformed AI context JSON but keeps description', () => {
    const body = `🟠 ✨ **Suggestion**: Title\n\nValid description.\n\n<details>\n<summary>AI context</summary>\n\n\`\`\`json\n{not valid json}\n\`\`\`\n</details>`;
    const result = parseFindingFromComment(body);
    expect(result.description).toBe('Valid description.');
    expect(result.suggestedFix).toBeUndefined();
  });

  it('returns undefined suggestedFix when fix key is absent from valid JSON', () => {
    const body = makeCommentBody('Desc.', '{"severity":"suggestion","confidence":"high","flaggedBy":["Correctness"]}');
    const result = parseFindingFromComment(body);
    expect(result.description).toBe('Desc.');
    expect(result.suggestedFix).toBeUndefined();
  });

  it('returns {} when no severity heading is found', () => {
    const result = parseFindingFromComment('No heading here, just random text.');
    expect(result).toEqual({});
  });

  it('returns description: undefined when no prose between title and first stop marker', () => {
    const body = `🟠 ✨ **Suggestion**: Title\n\n<details>\n<summary>Suggested fix</summary>\n\`\`\`suggestion\nfix\n\`\`\`\n</details>`;
    const result = parseFindingFromComment(body);
    expect(result.description).toBeUndefined();
  });

  it('strips leading <sub> lines from description', () => {
    const body = `🟠 ✨ **Suggestion**: Title\n\n<sub>[Confidence: high]</sub>\nActual description text.\n\n<details>\n<summary>AI context</summary>\n\n\`\`\`json\n{}\n\`\`\`\n</details>`;
    const result = parseFindingFromComment(body);
    expect(result.description).toBe('Actual description text.');
  });

  it('caps description at 500 chars and appends ellipsis', () => {
    const longDesc = 'x'.repeat(600);
    const body = makeCommentBody(longDesc);
    const result = parseFindingFromComment(body);
    expect(result.description).toHaveLength(503);
    expect(result.description).toMatch(/\.\.\.$/);
  });

  it('caps suggestedFix at 300 chars and appends ellipsis', () => {
    const longFix = 'y'.repeat(400);
    const body = makeCommentBody('Desc.', `{"fix":"${longFix}","severity":"suggestion"}`);
    const result = parseFindingFromComment(body);
    expect(result.suggestedFix).toHaveLength(303);
    expect(result.suggestedFix).toMatch(/\.\.\.$/);
  });
});

describe('collectResolvedThreadIds', () => {
  it('returns an empty set for an undefined input', () => {
    expect(collectResolvedThreadIds(undefined).size).toBe(0);
  });

  it('returns an empty set for an empty array', () => {
    expect(collectResolvedThreadIds([]).size).toBe(0);
  });

  it('includes only `resolved` entries with a `threadId`', () => {
    const result = collectResolvedThreadIds([
      { title: 'a', file: 'f', line: 1, severity: 'warning', status: 'resolved', threadId: 'T1' },
      { title: 'b', file: 'f', line: 2, severity: 'warning', status: 'open', threadId: 'T2' },
      { title: 'c', file: 'f', line: 3, severity: 'warning', status: 'replied', threadId: 'T3' },
      { title: 'd', file: 'f', line: 4, severity: 'warning', status: 'resolved', threadId: 'T4' },
    ]);
    expect(result).toEqual(new Set(['T1', 'T4']));
  });

  it('skips `resolved` entries that lack a `threadId`', () => {
    const result = collectResolvedThreadIds([
      { title: 'a', file: 'f', line: 1, severity: 'warning', status: 'resolved' },
      { title: 'b', file: 'f', line: 2, severity: 'warning', status: 'resolved', threadId: 'T2' },
    ]);
    expect(result).toEqual(new Set(['T2']));
  });
});

describe('titleOverlapType', () => {
  it("returns 'exact' for identical titles", () => {
    expect(titleOverlapType('Missing null check', 'Missing null check')).toBe('exact');
  });

  it("returns 'exact' case-insensitively", () => {
    expect(titleOverlapType('Missing Null Check', 'missing null check')).toBe('exact');
  });

  it("returns 'substring' when one title contains the other (>=5 chars)", () => {
    expect(titleOverlapType('Missing null check in processBlock', 'Missing null check')).toBe('substring');
  });

  it("returns 'word_overlap' for short-title overlap below the substring length threshold", () => {
    expect(titleOverlapType('Bug in parser', 'Bug')).toBe('word_overlap');
  });

  it('returns null when there is no substring and insufficient word overlap', () => {
    expect(titleOverlapType('Memory leak in pool', 'Missing error handler')).toBeNull();
  });

  it("returns 'word_overlap' when >=50% words overlap but no substring", () => {
    expect(titleOverlapType(
      'FFI removes is_ours without adding replacement',
      'FFI API regression: is_ours removed with no replacement',
    )).toBe('word_overlap');
  });

  it('returns null when titles are unrelated', () => {
    expect(titleOverlapType('Memory leak in connection pool', 'Missing error handling in parser')).toBeNull();
  });
});

describe('refreshAuthorReplyClass', () => {
  function makeRound(entries: FindingFingerprintEntry[]): RoundContext {
    return {
      meta: { prNumber: 1, commitSha: 'abc', round: 1, timestamp: '2026-01-01T00:00:00.000Z', mankiVersion: '1.0.0' },
      config: { reviewLevel: 'medium', memoryEnabled: false },
      diff: { lines: 0, additions: 0, deletions: 0, filesReviewed: 0, fileTypes: {} },
      models: { reviewer: 'r', judge: 'j' },
      planner: { source: 'disabled', used: false },
      reviewers: { agents: [] },
      judge: { summary: '' },
      dedup: {},
      memory: {},
      findings: { count: entries.length, severityCounts: { blocker: 0, warning: 0, suggestion: 0, nitpick: 0 }, entries },
      usage: {},
      verdict: 'COMMENT',
    };
  }

  function makeEntry(overrides: Partial<FindingFingerprintEntry> = {}): FindingFingerprintEntry {
    return {
      fingerprint: { file: 'src/foo.ts', slug: 'test-finding', lineStart: 10, lineEnd: 10 },
      severity: 'suggestion',
      authorReplyClass: 'none',
      ...overrides,
    };
  }

  it('returns empty result for empty rounds array', () => {
    const result = refreshAuthorReplyClass([], []);
    expect(result.rounds).toEqual([]);
    expect(result.reclassifiedPriorCount).toBe(0);
    expect(result.reclassifiedPriors).toEqual([]);
  });

  it('counts a threadId flip and records it in entries', () => {
    const entry = makeEntry({ threadId: 'T1', authorReplyClass: 'none' });
    const rounds = [makeRound([entry])];
    const previousFindings: PreviousFinding[] = [
      { title: 'Test finding', file: 'src/foo.ts', line: 10, severity: 'suggestion', status: 'resolved', threadId: 'T1', authorReplyText: 'LGTM fixed' },
    ];

    const result = refreshAuthorReplyClass(rounds, previousFindings);
    expect(result.reclassifiedPriorCount).toBe(1);
    expect(result.reclassifiedPriors).toHaveLength(1);
    expect(result.reclassifiedPriors[0]).toMatchObject({ threadId: 'T1', from: 'none' });
  });

  it('increments count for slug-file fallback flips but omits them from entries', () => {
    const entry = makeEntry({ threadId: undefined, fingerprint: { file: 'src/foo.ts', slug: 'Test-finding', lineStart: 10, lineEnd: 10 }, authorReplyClass: 'none' });
    const rounds = [makeRound([entry])];
    const previousFindings: PreviousFinding[] = [
      { title: 'Test finding', file: 'src/foo.ts', line: 10, severity: 'suggestion', status: 'resolved', authorReplyText: 'fixed' },
    ];

    const result = refreshAuthorReplyClass(rounds, previousFindings);
    expect(result.reclassifiedPriorCount).toBe(1);
    expect(result.reclassifiedPriors).toHaveLength(0);
  });

  it('records every flip', () => {
    const entries = Array.from({ length: 55 }, (_, i) => makeEntry({ threadId: `T${i}`, authorReplyClass: 'none' }));
    const previousFindings: PreviousFinding[] = entries.map((e, i) => ({
      title: 'Test finding', file: 'src/foo.ts', line: 10, severity: 'suggestion' as const, status: 'resolved' as const, threadId: `T${i}`, authorReplyText: 'fixed',
    }));

    const result = refreshAuthorReplyClass([makeRound(entries)], previousFindings);
    expect(result.reclassifiedPriorCount).toBe(55);
    expect(result.reclassifiedPriors).toHaveLength(55);
  });
});
