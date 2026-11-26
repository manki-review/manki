import { AuthorReplyClass, Finding, FindingFingerprintEntry, ReplyDecision, RoundContext, SCOPE_DOUBT_TITLE, SCOPE_READER_NAME, SCOPE_SPLIT_TITLE, SECURITY_TAG, ThreadEvaluation, threadBlocks } from './types';
import { clearRecordMarker, UNSETTLED_ANSWER_MARKER, collectGuardedThreadIds, collectInPrSuppressions, isGuarded, collectResolvedThreadIds, currentFindingLine, deduplicateFindings, dismissRecordMarker, fingerprintFinding, findingPlace, PreviousFinding, fetchRecapState, REOPENED_MARKER, securityOverrideMarker, titlesOverlap, titleOverlapType, refreshAuthorReplyClass, replyClassOf, llmDeduplicateFindings, parseFindingFromComment, RAISED_MARKER, threadSeverity } from './recap';
import { AUTO_APPROVE_MARKER, BOT_LOGIN, formatFindingComment, titleToSlug } from './github';
import { LAST_PAGE, makeFindingFingerprintEntry, makeRoundContext, paginateSinglePage, TEST_BOT, TEST_LINKS } from './test-utils';
import { determineOutcome } from './review';
import { CheckedReply, statementFold, statementList, statementSummary } from './reply-check';
import { fixedMarker, formatReplyRecord, formatReviewRecord, settledReplyId, settlingDecision, settlingPlaces, smallerRecords } from './review-record';
import { highlightCode } from './highlight';
import { applyCrossRoundSuppression } from './judge';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

import * as core from '@actions/core';

const makeFinding = (overrides: Partial<Finding> = {}): Finding => ({
  severity: 'note',
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
  severity: 'note',
  status: 'open',
  ...overrides,
});

/** Manki's answer to a reply, with the reply record that says how it decided the thread. */
/** The id of the developer's reply that `recordedAnswer` answers by default. */
const REPLY_ID = 7;
const recordedAnswer = (outcome: ReplyDecision['outcome'], thread: ReplyDecision['thread'] = 'resolves', answers = REPLY_ID): string => `**${outcome}.** Checked.\n\n<!-- manki -->\n${formatReplyRecord({
  kind: 'thread-reply', prNumber: 1, timestamp: '2026-11-18T10:00:00Z', mankiVersion: '7.7.0', usage: {}, decision: { outcome, thread }, answers,
})}`;

describe('deduplicateFindings', () => {
  it('detects exact match by title, file, and line', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42, status: 'resolved' })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].matchType).toBe('exact');

    // A resolved suggestion on the same spot drops a later suggestion, never a warning.
    const suggestion = makePrevious({ ...previous[0], severity: 'note' });
    expect(deduplicateFindings([{ ...findings[0], severity: 'note' }], [suggestion]).duplicates).toHaveLength(1);
    expect(deduplicateFindings([{ ...findings[0], severity: 'warning' }], [suggestion]).unique).toHaveLength(1);

    const fixed = makePrevious({ ...previous[0], line: 40, fixed: true });
    const kept = deduplicateFindings(findings, [fixed]);
    expect(kept.duplicates).toHaveLength(0);
    expect(kept.unique).toEqual([{ ...findings[0], resemblesFixed: { title: 'Missing null check', file: 'src/foo.ts', line: 40 } }]);
    expect(deduplicateFindings(findings, [fixed, ...previous]).duplicates).toHaveLength(1);

    // A lockfile alert on a nearby package shares most words with a waived one, but names another package.
    const waivedAlert = makePrevious({ title: 'lockfile-change: updated hex 0.4.3 -> 0.4.2: downgrade.', file: 'Cargo.lock', line: 40, status: 'resolved' });
    const alerts = [makeFinding({ title: 'lockfile-change: updated hey 0.4.3 -> 0.4.2: downgrade.', file: 'Cargo.lock', line: 44 })];
    expect(deduplicateFindings(alerts, [waivedAlert]).unique).toEqual(alerts);
    expect(deduplicateFindings([{ ...alerts[0], title: waivedAlert.title }], [waivedAlert]).duplicates).toHaveLength(1);
  });

  it('drops a repeat of an answered thread on a file unchanged since the last round, and sends any other to the judge with the answer', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];
    const answered = makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42, status: 'auto-resolved', threadId: 'T1', answer: 'Withdrawn. `id` is checked first.' });

    expect(deduplicateFindings(findings, [answered], new Set(['src/bar.ts']))).toEqual({
      unique: [],
      duplicates: [{ finding: findings[0], matchedTitle: 'Missing null check', matchType: 'exact' }],
    });
    const toJudge = [{ ...findings[0], answeredIn: { threadId: 'T1', answer: 'Withdrawn. `id` is checked first.', grade: { severity: answered.severity } } }];
    expect(deduplicateFindings(findings, [answered], new Set(['src/foo.ts'])).unique).toEqual(toJudge);
    expect(deduplicateFindings(findings, [answered]).unique).toEqual(toJudge);
    // An answer that cited lines may rest on another file the push changed, so its repeat goes to the judge, where the lines are checked.
    expect(deduplicateFindings(findings, [{ ...answered, answerPlaces: ['src/caller.ts:30'] }], new Set(['src/caller.ts'])).unique).toEqual(toJudge);
    expect(deduplicateFindings(findings, [{ ...answered, line: 0, originalLine: 41 }]).unique).toEqual(toJudge);
    expect(deduplicateFindings(findings, [{ ...answered, originalLine: 10 }]).unique).toEqual(toJudge);
    expect(deduplicateFindings(findings, [{ ...answered, answer: undefined }], new Set()).unique).toEqual(findings);
    const unrelated = [makeFinding({ title: 'Unrelated race', file: 'src/foo.ts', line: 42 })];
    expect(deduplicateFindings(unrelated, [answered], new Set()).unique).toEqual(unrelated);
    // A title that only shares words with the answered one may name another defect, so it goes to the judge on its own.
    const reworded = [makeFinding({ title: 'Missing null check in the parser', file: 'src/foo.ts', line: 42 })];
    expect(deduplicateFindings(reworded, [answered], new Set())).toEqual({ unique: reworded, duplicates: [] });
  });

  it('matches only the same title on a nearby line, and leaves a reworded or moved repeat to the dedup model', () => {
    const findings = [
      makeFinding({ title: 'Missing null check', file: 'src/a.ts', line: 10 }),
      makeFinding({ title: 'Missing null check in processBlock', file: 'src/b.ts', line: 10 }),
      makeFinding({ title: 'FFI API regression: is_ours removed with no replacement', file: 'src/c.rs', line: 10 }),
      makeFinding({ title: 'Unsafe cast should use type guard', file: 'src/d.ts', line: 33 }),
      makeFinding({ title: 'Missing null check before dereference', file: 'src/e.ts', line: 60 }),
    ];
    const previous = [
      makePrevious({ title: 'Missing null check', file: 'src/a.ts', line: 10, status: 'resolved' }),
      makePrevious({ title: 'Missing null check', file: 'src/b.ts', line: 10, status: 'resolved' }),
      makePrevious({ title: 'FFI removes is_ours without adding replacement', file: 'src/c.rs', line: 10, status: 'resolved' }),
      makePrevious({ title: 'Unsafe type cast without guard', file: 'src/d.ts', line: 30, status: 'resolved' }),
      makePrevious({ title: 'Missing null check before dereference', file: 'src/e.ts', line: 45, status: 'resolved' }),
    ];

    const result = deduplicateFindings(findings, previous);
    expect(result.duplicates.map(d => [d.finding.title, d.matchType])).toEqual([['Missing null check', 'exact']]);
    expect(result.unique).toEqual(findings.slice(1));
  });

  it('detects fuzzy line match within +/-5 lines', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 45 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42, status: 'resolved' })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);

    // An outdated thread has `line` 0, so it is matched on the line its finding was posted on.
    expect(deduplicateFindings(findings, [{ ...previous[0], line: 0, originalLine: 30, findingLine: 42 }]).duplicates).toHaveLength(1);
    expect(deduplicateFindings(findings, [{ ...previous[0], line: 0, originalLine: 20 }]).duplicates).toHaveLength(0);
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

  it('does not match completely different titles', () => {
    const findings = [makeFinding({ title: 'Memory leak in connection pool', file: 'src/pool.ts', line: 10 })];
    const previous = [makePrevious({ title: 'Missing error handling in parser', file: 'src/pool.ts', line: 10, status: 'resolved' })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
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

    // A thread posted on another file for a blocker without a line stands for the whole file, so the same title on any
    // line repeats it once someone allowed to cleared it. A title that only overlaps does not, and neither does a line-less
    // thread on the finding's own file.
    const blocker = makeFinding({ ...findings[0], severity: 'blocker' });
    const wholeFile = makePrevious({ ...previous[0], line: 0, severity: 'blocker', detached: true });
    expect(deduplicateFindings([blocker], [wholeFile]).duplicates.map(d => d.matchType)).toEqual(['exact']);
    expect(deduplicateFindings([{ ...blocker, title: 'Missing null-check before dereference' }], [wholeFile]).duplicates).toHaveLength(1);
    expect(deduplicateFindings([{ ...blocker, title: 'Missing null check before the dereference in the loader' }], [wholeFile]).unique).toHaveLength(1);
    expect(deduplicateFindings([blocker], [{ ...wholeFile, detached: undefined }]).unique).toHaveLength(1);
    // The thread still has to be cleared: one the PR author resolved alone stays open and hides nothing.
    expect(deduplicateFindings([blocker], [{ ...wholeFile, status: 'open' }]).unique).toHaveLength(1);
    // With a line, such a thread matches by that line like any other.
    expect(deduplicateFindings([blocker], [{ ...wholeFile, line: 45 }]).unique).toHaveLength(1);
    expect(deduplicateFindings([blocker], [{ ...wholeFile, line: 66 }]).duplicates).toHaveLength(1);
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
          author: { login: 'manki-review[bot]' } as { login: string; __typename?: string },
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
        // Every login is a person with write access unless a test says otherwise.
        repos: { getCollaboratorPermissionLevel: jest.fn().mockResolvedValue({ data: { permission: 'write', role_name: 'write', user: { type: 'User' } } }) },
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
    expect(state.previousFindings[0].severity).toBe('note');
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

  it('reads the levels of older versions in thread markers and round records as the levels they became', async () => {
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
      ...['suggestion', 'nitpick'].map((old, i) => makeThread({
        id: `t${i + 3}`,
        comments: { nodes: [{ body: `<!-- manki:${old}:Old-${old} --> **Old**: an older level`, author: { login: 'manki-review[bot]' } }] },
      })),
    ], [{
      id: 1, user: { login: 'manki-review[bot]' }, body: `<!-- manki-context: ${JSON.stringify(makeRoundContext(1, {
        findings: {
          count: 2, severityCounts: { blocker: 0, warning: 0, suggestion: 1, nitpick: 1 },
          entries: [
            { ...makeFindingFingerprintEntry({ title: 'Rename helper' }), severity: 'suggestion', reviewerSeverity: 'nitpick', gradePath: [{ from: 'nitpick', to: 'suggestion', by: 'judge' }] },
            { ...makeFindingFingerprintEntry({ title: 'Typo' }), severity: 'nitpick', originalSeverity: 'required' },
          ] as unknown as FindingFingerprintEntry[],
        },
      }))} -->`,
    }]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings.map(f => f.severity)).toEqual(['blocker', 'note', 'note', 'note']);
    expect(state.priorRounds[0].findings.severityCounts).toEqual({ blocker: 0, warning: 0, note: 2 });
    expect(state.priorRounds[0].findings.entries.map(e => [e.severity, e.reviewerSeverity, e.originalSeverity, e.gradePath])).toEqual([
      // The step between the two old levels is no grade change any more, so the entry keeps no path.
      ['note', 'note', undefined, undefined],
      ['note', undefined, 'blocker', undefined],
    ]);
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

  it.each<[string, string[], string?]>([
    ['without an earlier answer', []],
    ['after a "Withdrawn."', ['Withdrawn. `id` is checked first.\n\n<!-- manki -->']],
    ['after a "Kept."', ['Kept. `id` can be null here.\n\n<!-- manki -->']],
    ['posted before the state came first', [], 'The guard runs first. This reply does not settle the thread.\n\nThis warning holds the approval.'],
  ])('reads an unsettled answer as an "Unverified." one, %s', async (_name, earlier, text = '**Not settled yet: the next review checks the fix.** A reply can\'t settle it.\n\nFixed by the guard.\n\nThis warning holds the approval.') => {
    const comment = (login: string, body: string) => ({ body, author: { login } });
    const prior = async (answer: string, last = 'manki-review[bot]') => (await fetchRecapState(mockOctokit([makeThread({ id: 't1', comments: { nodes: [
      makeThread().comments.nodes[0], ...earlier.flatMap(body => [comment('author', 'Why?'), comment('manki-review[bot]', body)]), comment('author', 'Fixed in abc1234.'), comment(last, answer),
    ] } })]), TEST_BOT, 'owner', 'repo', 1)).previousFindings;

    const unsettled = await prior(`${text}\n\n<!-- manki -->\n${UNSETTLED_ANSWER_MARKER}`);
    expect(unsettled[0].answer).toBe(`Unverified. ${text}`);
    const unverified = await prior(`Unverified. ${text}\n\n<!-- manki -->`);
    expect(unsettled).toEqual(unverified);
    const repeat = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 10, severity: 'blocker' })];
    for (const changed of [new Set(['src/bar.ts']), new Set(['src/foo.ts']), undefined]) {
      expect(deduplicateFindings(repeat, unsettled, changed)).toEqual(deduplicateFindings(repeat, unverified, changed));
    }
    expect(deduplicateFindings(repeat, unsettled, new Set(['src/bar.ts'])).duplicates).toHaveLength(1);
    expect(deduplicateFindings(repeat, unsettled).unique[0].answeredIn?.answer).toBe(`Unverified. ${text}`);

    // Only Manki's own marker below its comment marker counts.
    const spoofs = [[`${text}\n\n<!-- manki -->\n${UNSETTLED_ANSWER_MARKER}`, 'author'], [`${UNSETTLED_ANSWER_MARKER}\n\n${text}\n\n<!-- manki -->`, undefined]] as const;
    for (const [body, login] of spoofs) expect((await prior(body, login))[0].answer).toBe(earlier[0]?.split('\n\n')[0]);
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
    const record = (round: number, threadEvaluations: ThreadEvaluation[], carried: string[] = []) => ({
      id: round, user: { login: 'manki-review[bot]' }, body: `<!-- manki-context: ${JSON.stringify(makeRoundContext(round, {
        judge: { summary: '', threadEvaluations },
        findings: { count: carried.length, severityCounts: {}, entries: carried.map(threadId => makeFindingFingerprintEntry({ title: 'Came back', severity: 'blocker', threadId })) },
      }))} -->`,
    });
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        isResolved: false,
        comments: {
          nodes: [
            {
              body: '<!-- manki:blocker:Bug --> \u{1F6AB} **Blocker**: Bug found\n\nDesc.',
              author: { login: 'manki-review[bot]' },
              originalCommit: { oid: 'c0ffee' },
            },
            {
              body: 'Fixed, done.',
              author: { login: 'developer' },
            },
            // The answer to a fix in another PR settles nothing, but it is still Manki's answer in the thread.
            { body: 'Confirmed: #7, merged into `main`, replaced the cited line.\n\n<!-- manki -->', author: { login: 'manki-review[bot]' } },
          ],
        },
      }),
      makeThread({
        id: 't2',
        comments: {
          nodes: [
            { body: '<!-- manki:blocker:Bug --> \u{1F6AB} **Blocker**: Bug found\n\nDesc.', author: { login: 'manki-review[bot]' } },
            { body: 'It is intended.', author: { login: 'developer' } },
            // The reply model's answer is posted as a plain "Agreed.", so its words never name a filed issue.
            { body: 'Agreed. Filed as #7 for later work.\n\n<!-- manki -->', author: { login: 'manki-review[bot]' } },
            { body: '**Withdrawn.** `load` returns early.\n\n<!-- manki -->', author: { login: 'manki-review[bot]' } },
            { body: 'Agreed. Developer text that looks like an answer.', author: { login: 'developer' } },
            { body: '**Agreed.** Filed as #9 for later work.', author: { login: 'developer' } },
            { body: 'Fixed in abc1234.\n\n<!-- manki -->', author: { login: 'manki-review[bot]' } },
          ],
        },
      }),
      makeThread({
        id: 't3',
        comments: {
          nodes: [
            { body: '<!-- manki:warning:Bug --> **Warning**: Bug found\n\nDesc.', author: { login: 'manki-review[bot]' } },
            { body: '**Agreed.** Filed as #12 for later work.\n\n<!-- manki -->\n<!-- manki-tracked -->', author: { login: 'manki-review[bot]' } },
            { body: 'Agreed. Handling it later is fine.\n\n<!-- manki -->', author: { login: 'manki-review[bot]' } },
            { body: 'This came up again.\n\nDetails.\n\n<!-- manki -->\n<!-- manki-found-again -->', author: { login: 'manki-review[bot]' } },
          ],
        },
      }),
      makeThread({
        id: 't4',
        comments: {
          nodes: [
            { body: '<!-- manki:blocker:Upload --> **Blocker**: Upload\n\nDesc.', author: { login: 'manki-review[bot]' } },
            { body: '**Partly fixed.** Still open: a slow log.\n\n<!-- manki -->', author: { login: 'manki-review[bot]' } },
          ],
        },
      }),
      makeThread({
        id: 't6',
        comments: {
          nodes: [
            { body: formatFindingComment({ severity: 'blocker', title: 'Token in log', file: 'src/a.ts', line: 3, description: 'd', reviewers: [], tags: ['security'] }, TEST_LINKS), author: { login: 'manki-review[bot]' } },
          ],
        },
      }),
      makeThread({
        id: 't5',
        comments: {
          nodes: [
            { body: '<!-- manki:blocker:Upload --> **Blocker**: Upload\n\nDesc.', author: { login: 'manki-review[bot]' } },
            { body: 'This came up again.\n\n<!-- manki -->\n<!-- manki-found-again-blocker -->', author: { login: 'manki-review[bot]' } },
            // A pointer at a round's verdict is no answer.
            { body: `The review of \`aaaaaaa\`, which finished after this reply, confirmed this fix.\n\n${recordedAnswer('Fixed', 'confirmed_by_round').split('\n\n')[1]}`, author: { login: 'manki-review[bot]' } },
          ],
        },
      }),
    ], [
      // The round records keep the grade each partial fix left, and the latest one counts. Only Manki's records count.
      record(1, [{ threadId: 't4', status: 'partly_addressed', reason: 'r', remaining: 'No timeout.', grade: 'warning' }]),
      record(2, [
        { threadId: 't4', status: 'partly_addressed', reason: 'r', remaining: 'A slow log.', grade: 'note' },
        { threadId: 't5', status: 'partly_addressed', reason: 'r', remaining: 'A slow log.', grade: 'note' },
        { threadId: 't6', status: 'partly_addressed', reason: 'r', remaining: 'One log line.', grade: 'warning' },
      ]),
      // A blocker a round carried on a thread raises it, after any partial fix in that round or before.
      record(3, [{ threadId: 't4', status: 'not_addressed', reason: 'r' }, { threadId: 't3', status: 'partly_addressed', reason: 'r', remaining: 'r', grade: 'note' }], ['t3', 't5']),
      { ...record(4, [{ threadId: 't1', status: 'partly_addressed', reason: 'r', remaining: 'r', grade: 'note' }]), user: { login: 'developer' } },
    ]);

    const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
    expect(state.previousFindings[0].authorReplyText).toBe('Fixed, done.');
    // The commit a thread was posted on still holds the code it named after the thread goes outdated.
    expect(state.previousFindings.map(f => f.originalCommit)).toEqual(['c0ffee', undefined, undefined, undefined, undefined, undefined]);
    expect(state.previousFindings.slice(0, 3).map(f => f.answer)).toEqual(['Confirmed: #7, merged into `main`, replaced the cited line.', '**Withdrawn.** `load` returns early.', 'This came up again.\n\nDetails.']);
    expect(state.previousFindings[5].answer).toBeUndefined();
    // Only Manki's own filed reply names an issue, and a later answer in the thread keeps it.
    expect(state.previousFindings.slice(0, 3).map(f => f.filedIssue)).toEqual([undefined, undefined, 12]);
    // A severity comes from the first comment only, and no reply marker raises it, not even a pasted one.
    expect(state.previousFindings.map(f => f.severity)).toEqual(['blocker', 'blocker', 'warning', 'blocker', 'blocker', 'blocker']);
    // A security thread keeps a recorded lower grade too, which `threadBlocks` never lets lower it.
    expect(state.previousFindings.map(f => f.recordedGrade)).toEqual([undefined, undefined, 'blocker', 'note', 'warning', 'blocker']);
    // The peak keeps the highest grade the records ever gave, so a lowered thread can get it back.
    expect(state.previousFindings.map(f => f.peakGrade)).toEqual([undefined, undefined, 'blocker', 'warning', 'warning', 'blocker']);
    expect(state.previousFindings.map(f => threadBlocks(f))).toEqual([true, true, true, false, true, true]);
    // Only a thread that still blocks needs someone other than the PR author to clear it.
    expect(state.previousFindings.map(f => isGuarded(f))).toEqual([true, true, true, false, true, true]);
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

    // Manki's record of the maintainer it cleared the thread for backs its resolve only when no later reopen can be missing.
    // A reply after the record, here the PR author's, changes nothing.
    const backed = async (pageInfo: { hasNextPage: boolean; endCursor: string | null }, after: Array<{ body: string; author: { login: string } }> = []) => {
      const nodes = [...makeThread().comments.nodes, { body: 'Every caller checks it.', author: { login: 'bob' } },
        { body: `**Withdrawn.** Every caller checks it.\n\n<!-- manki -->\n${clearRecordMarker('bob')}`, author: { login: 'manki-review[bot]' } }, ...after];
      const cut = mockOctokit([makeThread({ id: 'tb', isResolved: true, resolvedBy: { login: 'manki-review[bot]' }, comments: { pageInfo, nodes } })]);
      Object.assign(cut.rest, { repos: { getCollaboratorPermissionLevel: jest.fn(async () => ({ data: { permission: 'write', user: { type: 'User' } } })) } });
      return (await fetchRecapState(cut, TEST_BOT, 'owner', 'repo', 1, 'author')).previousFindings.map(f => [f.status, !!f.authorReplyMayClear, f.reopen]);
    };
    expect(await backed(LAST_PAGE)).toEqual([['auto-resolved', true, undefined]]);
    expect(await backed(LAST_PAGE, [{ body: 'Thanks!', author: { login: 'author' } }])).toEqual([['auto-resolved', false, undefined]]);
    // Such a thread blocks, but is not reopened: the record may sit on a page Manki did not read.
    expect(await backed({ hasNextPage: true, endCursor: 'c1' })).toEqual([['replied', false, undefined]]);
  });

  it('carries the fix claim of Manki\'s own answer on a blocker the PR author dismissed, and none from a thread not read in full', async () => {
    const claim = (login: string, body = 'Unverified. You name #7.\n\n<!-- manki -->\n<!-- manki-fix-claim:7:confirmed -->') => ({ body, author: { login } });
    const cleared = async (reply: ReturnType<typeof claim>, pageInfo: { hasNextPage: boolean; endCursor: string | null } = LAST_PAGE) => {
      const nodes = [...makeThread().comments.nodes, reply];
      const octokit = mockOctokit([makeThread({ id: 'tc', isResolved: true, resolvedBy: { login: 'author' }, comments: { pageInfo, nodes } })]);
      Object.assign(octokit.rest, { repos: { getCollaboratorPermissionLevel: jest.fn(async () => ({ data: { permission: 'maintain', role_name: 'maintain', user: { type: 'User' } } })) } });
      return (await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1, 'author', 'maintain')).previousFindings[0];
    };
    const override = async (...args: Parameters<typeof cleared>) => (await cleared(...args)).securityOverride;

    expect(await override(claim('manki-review[bot]'))).toEqual({ login: 'author', via: 'resolve', role: 'maintain', announced: false, fixClaim: { pr: 7, status: 'confirmed' } });
    // The marker counts only in Manki's own reply. A person's reply that names another pull request is a claim Manki did not check.
    expect(await override(claim('author'))).toEqual({ login: 'author', via: 'resolve', role: 'maintain', announced: false, fixClaim: { pr: 7, status: 'unchecked' } });
    expect(await override(claim('reader', 'Fixed in https://github.com/owner/repo/pull/12, see `#13` and #1.'))).toEqual({ login: 'author', via: 'resolve', role: 'maintain', announced: false, fixClaim: { pr: 12, status: 'unchecked' } });
    // A maintainer's dismiss record is no override, so the author's override recorded after it still counts as announced.
    const dismissRecord = claim('manki-review[bot]', `Finding dismissed by \`@bob\`, who has write access to this repository.\n\n<!-- manki -->\n${dismissRecordMarker('bob')}`);
    const recorded = claim('manki-review[bot]', `Dismissed.\n<!-- manki -->\n${securityOverrideMarker('resolve', 'author')}`);
    const afterRecord = async (nodes: Array<ReturnType<typeof claim>>) => {
      const octokit = mockOctokit([makeThread({ id: 'tc', isResolved: true, resolvedBy: { login: 'author' }, comments: { pageInfo: LAST_PAGE, nodes: [...makeThread().comments.nodes, ...nodes] } })]);
      Object.assign(octokit.rest, { repos: { getCollaboratorPermissionLevel: jest.fn(async () => ({ data: { permission: 'maintain', role_name: 'maintain', user: { type: 'User' } } })) } });
      return (await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1, 'author', 'maintain')).previousFindings[0].securityOverride;
    };
    expect(await afterRecord([dismissRecord, recorded])).toEqual({ login: 'author', via: 'resolve', role: 'maintain', announced: true });
    expect(await afterRecord([dismissRecord])).toEqual({ login: 'author', via: 'resolve', role: 'maintain', announced: false });
    // A later answer may be missing, so the thread names no claim.
    expect(await override(claim('manki-review[bot]'), { hasNextPage: true, endCursor: 'c1' })).toEqual({ login: 'author', via: 'resolve', role: 'maintain', announced: false });

    // The PR author's clearing with a role settles the thread without a fix, unless an answer of Manki's confirmed one.
    // Only a thread read in full says so.
    // Only Manki's record of the clearing counts, so a clearing Manki has not recorded yet waives nothing.
    const settled = async (...args: Parameters<typeof cleared>) => (await cleared(...args)).decidedWithoutFix ?? false;
    expect(await settled(claim('manki-review[bot]', `Dismissed.\n<!-- manki -->\n${securityOverrideMarker('resolve', 'author')}`))).toBe(true);
    expect(await settled(claim('manki-review[bot]'))).toBe(false);
    expect(await settled(claim('manki-review[bot]', `Fixed by the commits up to abc1234.\n\n<!-- manki -->\n${fixedMarker('a'.repeat(40))}`))).toBe(false);
    expect(await settled(claim('manki-review[bot]'), { hasNextPage: true, endCursor: 'c1' })).toBe(false);
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

    // The labels, a prose fix and the line saying nothing was checked are not read back as description.
    const unchecked = formatFindingComment({ severity: 'warning', title: 'Unchecked', file: 'src/a.ts', line: 4, description: 'It goes wrong.', suggestedFix: 'Handle the `None` case separately.', reviewers: ['SecurityReviewer'] }, TEST_LINKS);
    expect(unchecked).toContain('**What goes wrong:** It goes wrong.\n\n<!-- manki-checks -->\n<details>\n<summary>How to fix it · not checked against the code</summary>');
    const readBack = async (comment: string) => (await fetchRecapState(mockOctokit([makeThread({ id: 't2', isResolved: false, comments: { nodes: [{ body: comment, author: { login: 'manki-review[bot]' } }] } })]), TEST_BOT, 'owner', 'repo', 1)).previousFindings[0];
    expect((await readBack(unchecked)).description).toBe('It goes wrong.');
    // A fix given in words is read back as words, never as the code fix.
    const advised = await readBack(formatFindingComment({ severity: 'warning', title: 'Advised', file: 'src/a.ts', line: 4, description: 'It goes wrong.', howToFix: 'Return early when it is missing', reviewers: ['SecurityReviewer'] }, TEST_LINKS));
    expect(advised).toMatchObject({ description: 'It goes wrong.', howToFix: 'Return early when it is missing' });
    expect(advised.suggestedFix).toBeUndefined();
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
        findings: { count: 0, severityCounts: { blocker: 0, warning: 0, note: 0 }, entries: [] },
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

    it('round-trips findings.entries with specialist, suggestedFix, and title fields, also from a minimal record', async () => {
      const entry = {
        fingerprint: { file: 'src/foo.ts', lineStart: 10, lineEnd: 12, slug: 'misleading-variable-name' },
        severity: 'warning' as const,
        specialist: 'Correctness',
        suggestedFix: 'Rename `x` to `userCount`.',
        title: 'Misleading variable name',
      };
      const ctx = makeRoundContext(1, {
        findings: { count: 1, severityCounts: { blocker: 0, warning: 1, note: 0 }, entries: [entry] },
      });
      // A round too large for its review posts the last of `smallerRecords`, which later rounds read like any other.
      const blocker = { fingerprint: { file: 'src/bar.ts', lineStart: 4, lineEnd: 4, slug: 'lost-update' }, severity: 'blocker' as const, title: 'Lost update', threadId: 'T_BLOCKER', judgeNotes: 'Long reasoning.', tags: ['disproved-blocker'],
        originCheck: { lineChanged: true, answers: [{ verdict: 'pre_existing' as const, reason: 'The base reads under the lock.', model: 'm', fixedElsewhere: 'src/bar.ts:9' }] } };
      const threadEvaluations: ThreadEvaluation[] = [{ threadId: 'T_OLD', status: 'partly_addressed', reason: 'Half done.', grade: 'warning' }];
      const [minimal] = [...smallerRecords(makeRoundContext(2, {
        findings: { count: 1, severityCounts: { blocker: 1, warning: 0, note: 0 }, entries: [blocker] },
        judge: { summary: 'ok', threadEvaluations },
        usage: { llmCalls: [] },
      }))].slice(-1);
      const octokit = mockOctokit([], [
        { id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } },
        { id: 101, body: formatReviewRecord(minimal, 0), user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds).toHaveLength(2);
      expect(state.priorRounds[0].findings.entries).toEqual([entry]);
      const { judgeNotes: _notes, ...kept } = blocker;
      // No later round reads the line an origin answer says this PR fixes the same failure at.
      const { fixedElsewhere: _fix, ...answer } = blocker.originCheck.answers[0];
      expect(state.priorRounds[1].meta.omitted).toEqual(['usage.llmCalls', 'findings.entries.judgeNotes', 'findings.entries.originCheck.fixedElsewhere']);
      expect(state.priorRounds[1].findings.entries).toEqual([{ ...kept, originCheck: { ...kept.originCheck, answers: [answer] } }]);
      expect(state.priorRounds[1].judge.threadEvaluations).toEqual(threadEvaluations);
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
      // Each of these got a thread of its own on line 5. The security one raised the plain thread, and the later plain one
      // came once that thread was closed. The security one names no place, as an older record does, so only its guard
      // tells the threads apart.
      const sum = { ...prior('src/sum.ts', 5, titleToSlug('Sum overflows')), title: 'Sum overflows', posted: 'thread' as const };
      const { posted: _posted, ...unplaced } = sum;
      const later = [{ ...unplaced, tags: [SECURITY_TAG] }, sum];
      const ctx = makeRoundContext(1, {
        findings: { count: 5, severityCounts: { blocker: 3, warning: 2, note: 0 }, entries: [...entries, sum] },
      });
      const ctx2 = makeRoundContext(2, { findings: { count: 2, severityCounts: { blocker: 0, warning: 2, note: 0 }, entries: later } });
      const sumThread = (id: string, security = false) => makeThread({
        id, path: 'src/sum.ts', line: 5,
        comments: { nodes: [{ body: formatFindingComment(makeFinding({ severity: 'warning', title: sum.title, file: 'src/sum.ts', line: 5, ...(security && { tags: [SECURITY_TAG] }) }), TEST_LINKS), author: { login: BOT_LOGIN } }] },
      });
      const thread = (id: string, isResolved: boolean, slug: string, originalLine: number, grade = 'warning') => makeThread({
        id,
        isResolved,
        line: null,
        originalLine,
        comments: { nodes: [{ body: `**x**: x\n\n<!-- manki:${grade}:${slug} -->`, author: { login: BOT_LOGIN } }] },
      });
      const octokit = mockOctokit([
        thread('T_FAR', false, 'Old-issue', 40, 'blocker'),
        thread('T_RESOLVED', true, 'Old-issue', 12, 'blocker'),
        // A suggestion thread on the blocker's own line is graded below it, so it is never the blocker's thread.
        thread('T_SUGGESTION', false, 'Old-issue', 10, 'note'),
        thread('T_OTHER', false, 'Other-issue', 60),
        makeThread({
          id: 'T_FILE',
          isResolved: true,
          path: 'src/bar.ts',
          line: null,
          originalLine: null,
          comments: { nodes: [{ body: '**Blocker**: x\n\n<!-- manki:blocker:File-issue -->', author: { login: BOT_LOGIN } }] },
        }),
        { ...sumThread('T_SUM'), isResolved: true },
        sumThread('T_SUM_SECURITY', true),
        sumThread('T_SUM_LATER'),
      ], [
        { id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } },
        { id: 101, body: htmlCommentBlock(ctx2), user: { login: BOT_LOGIN } },
      ]);

      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds[1].findings.entries.map(e => e.threadId)).toEqual(['T_SUM_SECURITY', 'T_SUM_LATER']);
      expect(state.priorRounds[0].findings.entries.at(-1)!.threadId).toBe('T_SUM');
      const attached = state.priorRounds[0].findings.entries.slice(0, -1);
      expect(attached.map(e => e.threadId)).toEqual(['T_RESOLVED', undefined, undefined, 'T_FILE']);

      // The resolved threads, line or file-level, retire their blockers, and the warning too far from its thread blocks
      // nothing, though thread `T_OTHER` is still open. Only the body-only blocker keeps blocking, whatever the PR changes.
      const openThreads = state.previousFindings
        .filter(f => f.status === 'open')
        .map(f => ({ threadId: f.threadId!, title: f.title, file: f.file, line: f.line, severity: f.severity }));
      const unresolved = (priors: typeof attached) => determineOutcome([], priors, openThreads, collectResolvedThreadIds(state.previousFindings)).verdictTrace.unresolvedPriors.map(p => p.file);
      expect(unresolved(attached)).toEqual(['src/body.ts']);
      expect(unresolved(attached.map(({ threadId: _threadId, ...rest }) => rest))).toEqual(['src/foo.ts', 'src/body.ts', 'src/bar.ts']);
    });

    it('gives a body-only blocker the thread of a blocker that restates it, and only one graded as a blocker with its guard', async () => {
      type Grade = 'blocker' | 'warning';
      const entry = (title: string, file: string, severity: Grade = 'blocker', extra: Partial<FindingFingerprintEntry> = {}) => ({
        fingerprint: { file, lineStart: 5, lineEnd: 5, slug: titleToSlug(title) }, severity, title, ...extra,
      });
      const keyOf = (e: ReturnType<typeof entry>) => `${e.fingerprint.file}:5:5:${e.fingerprint.slug}`;
      const listed = {
        restated: entry('Writers race', 'src/race.ts'),
        plainRestated: entry('Token leaks into logs', 'src/token.ts', 'blocker', { tags: [SECURITY_TAG] }),
        securityRestated: entry('Key leaks into logs', 'src/key.ts', 'blocker', { tags: [SECURITY_TAG] }),
        gone: entry('Cache goes stale', 'src/cache.ts'),
        lowered: entry('Retry never stops', 'src/retry.ts'),
        recordLowered: entry('Parse fails', 'src/parse.ts'),
        warned: entry('Lock is dropped', 'src/lock.ts'),
        alone: entry('Queue overflows', 'src/queue.ts'),
        chained: entry('Index drifts', 'src/index.ts'),
      };
      // Round 2 restates each under another title and line, linked by `sameAs`. The chained one is restated in its body too.
      const again = (of: ReturnType<typeof entry>, title: string, severity: Grade = 'blocker', extra: Partial<FindingFingerprintEntry> = {}) =>
        entry(title, 'src/later.ts', severity, { sameAs: keyOf(of), ...extra, fingerprint: { file: 'src/later.ts', lineStart: 30 + title.length, lineEnd: 30 + title.length, slug: titleToSlug(title) } });
      const round2 = [
        again(listed.restated, 'Two writers interleave'),
        again(listed.plainRestated, 'Token is logged'),
        again(listed.securityRestated, 'Key is logged', 'blocker', { tags: [SECURITY_TAG] }),
        again(listed.gone, 'Cache is stale'),
        again(listed.lowered, 'Retry loops forever'),
        again(listed.recordLowered, 'Parse breaks'),
        again(listed.warned, 'Lock may drop', 'warning'),
        again(listed.chained, 'Index is off'),
      ];
      // Round 3 lists the chained blocker again, and that one got a thread.
      const round3 = [entry('Index drifts', 'src/index.ts', 'blocker', { sameAs: keyOf(listed.chained), relisted: true })];
      // Round 3 also found `Parse breaks` partly fixed, which lowers its blocker thread to a warning.
      const lowering = { summary: '', threadEvaluations: [{ threadId: 'T_PARTLY', status: 'partly_addressed' as const, reason: 'Half of it.', grade: 'warning' as const }] };
      const rounds = [Object.values(listed), round2, round3].map((entries, i) => makeRoundContext(i + 1, { findings: { count: entries.length, severityCounts: {}, entries }, ...(i === 2 && { judge: lowering }) }));
      const posted = (id: string, e: ReturnType<typeof entry>, grade: Grade, security = false) => makeThread({
        id, path: e.fingerprint.file, line: e.fingerprint.lineStart,
        comments: { nodes: [{ body: formatFindingComment(makeFinding({ severity: grade, title: e.title, file: e.fingerprint.file, line: e.fingerprint.lineStart, ...(security && { tags: [SECURITY_TAG] }) }), TEST_LINKS), author: { login: BOT_LOGIN } }] },
      });
      const octokit = mockOctokit([
        posted('T_RACE', round2[0], 'blocker'),
        posted('T_PLAIN', round2[1], 'blocker'),
        posted('T_SECURITY', round2[2], 'blocker', true),
        // The thread of `Cache is stale` is gone. The thread of `Retry loops forever` was lowered to a warning.
        posted('T_LOW', round2[4], 'warning'),
        posted('T_PARTLY', round2[5], 'blocker'),
        posted('T_WARN', round2[6], 'warning'),
        posted('T_CHAIN', round3[0], 'blocker'),
      ], rounds.map((ctx, i) => ({ id: 100 + i, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } })));

      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.priorRounds.map(r => r.findings.entries.map(e => [e.title, e.threadId]))).toEqual([
        [
          ['Writers race', 'T_RACE'],
          // A security blocker never rides on a plain thread.
          ['Token leaks into logs', undefined], ['Key leaks into logs', 'T_SECURITY'],
          // Neither a gone thread, a thread graded below a blocker, one a round record lowered, nor a warning's thread carries a blocker.
          ['Cache goes stale', undefined], ['Retry never stops', undefined], ['Parse fails', undefined], ['Lock is dropped', undefined],
          ['Queue overflows', undefined], ['Index drifts', 'T_CHAIN'],
        ],
        [
          ['Two writers interleave', 'T_RACE'], ['Token is logged', 'T_PLAIN'], ['Key is logged', 'T_SECURITY'], ['Cache is stale', undefined],
          ['Retry loops forever', undefined], ['Parse breaks', 'T_PARTLY'], ['Lock may drop', 'T_WARN'], ['Index is off', 'T_CHAIN'],
        ],
        [['Index drifts', 'T_CHAIN']],
      ]);

      // The restated blocker blocks once, through its thread, while that thread is open, and never once the thread is resolved.
      const carried = state.priorRounds.slice(0, 2).map(r => r.findings.entries[0]);
      const race = { threadId: 'T_RACE', title: 'Two writers interleave', file: 'src/later.ts', line: 52, severity: 'blocker' as const };
      expect(determineOutcome([], carried, [race]).verdictTrace.unresolvedPriors.map(p => p.threadId)).toEqual(['T_RACE']);
      expect(determineOutcome([], carried, [], new Set(['T_RACE'])).outcome).toBe('READY');
    });

    it('matches a blocker posted on a fallback line to its thread by the line its finding data names', async () => {
      const title = 'Auto-approve still approves unread files';
      const slug = titleToSlug(title);
      const entry = { fingerprint: { file: 'src/state.ts', lineStart: 512, lineEnd: 512, slug }, severity: 'blocker' as const, title };
      const ctx = makeRoundContext(12, { findings: { count: 1, severityCounts: { blocker: 1, warning: 0, note: 0 }, entries: [entry] } });
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
      const { outcome, verdictReason } = determineOutcome([], priors, [], collectResolvedThreadIds(state.previousFindings));
      expect({ outcome, verdictReason }).toEqual({ outcome: 'READY', verdictReason: 'only_notes' });
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

    it('reads where a thread\'s finding sits from its finding data and the place GitHub reports', async () => {
      const entry = (title: string, file: string, line: number) => ({ fingerprint: { file, lineStart: line, lineEnd: line, slug: titleToSlug(title) }, severity: 'blocker' as const, title, posted: 'thread' as const });
      const entries = [entry('Persisters miss the lock', 'src/store.ts', 30), entry('The design drops retries', '', 0), entry('Named without the flag', 'src/old.ts', 7)];
      const ctx = makeRoundContext(12, { findings: { count: 3, severityCounts: { blocker: 3, warning: 0, note: 0 }, entries } });
      // Each thread sits on the first changed file. Only a flagged one takes its place from its finding data.
      const posted = (id: string, title: string, data?: Record<string, unknown>, line = 1, originalLine = 1) => makeThread({
        id, path: 'src/first.ts', line, originalLine,
        comments: { nodes: [{ body: `\u{1F6AB} **Blocker**: ${title}\n\nDesc.\n\n<!-- manki:blocker:${titleToSlug(title)} -->${data ? `\n<!-- manki-finding: ${JSON.stringify({ ...data, severity: 'blocker', title })} -->` : ''}`, author: { login: BOT_LOGIN } }] },
      });
      const octokit = mockOctokit([
        posted('T_FILE', 'Persisters miss the lock', { file: 'src/store.ts', line: 30, detached: true, evidenceFiles: ['src/lock.ts', 'src/store.ts', './src/lock.ts', '../secret.ts', '/etc/passwd', 'https://example.com/a.ts', 'src/a/../../../b.ts'] }),
        posted('T_NONE', 'The design drops retries', { file: '', line: 0, detached: true }),
        posted('T_OLD', 'Named without the flag', { file: 'src/old.ts', line: 7, evidenceFiles: ['src/lock.ts', 7] }),
        // On the finding's own file: a file-level thread for a finding without a line, a line thread whose code moved
        // down by four lines, and a thread from before the finding data.
        posted('T_WHOLE', 'The file has no owner', { file: 'src/first.ts', line: 0 }),
        posted('T_MOVED', 'The retry never stops', { file: 'src/first.ts', line: 40 }, 44, 40),
        posted('T_BARE', 'Written without finding data'),
      ], [{ id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } }]);

      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(state.previousFindings.map(f => [f.threadId, f.file, f.findingLine])).toEqual([
        ['T_FILE', 'src/store.ts', 30],
        ['T_NONE', '', undefined],
        ['T_OLD', 'src/first.ts', undefined],
        ['T_WHOLE', 'src/first.ts', undefined],
        ['T_MOVED', 'src/first.ts', 40],
        ['T_BARE', 'src/first.ts', undefined],
      ]);
      // GitHub reports a file-level thread on line 1. A flagged thread takes the line its data names, and none when it names none.
      // So does a file-level thread whose finding names no line. Any other thread keeps the line GitHub reports.
      expect(state.previousFindings.map(currentFindingLine)).toEqual([30, 0, 1, 0, 44, 1]);
      expect(state.previousFindings.map(f => [f.line, f.originalLine, f.detached])).toEqual([
        [30, undefined, true], [0, undefined, true], [1, 1, undefined], [0, undefined, undefined], [44, 40, undefined], [1, 1, undefined],
      ]);
      // The finding data names the other files the finding cited, each once, as plain repository paths and without its
      // own. A path that leaves the repository, an absolute path or a URL is dropped. A list that is not all names is not
      // read, so that thread counts only its own file.
      expect(state.previousFindings.map(f => f.evidenceFiles)).toEqual([['src/lock.ts'], undefined, undefined, undefined, undefined, undefined]);
      // So the round record's blocker finds its thread, and the thread from before the flag stays on GitHub's path.
      expect(state.priorRounds[0].findings.entries.map(e => e.threadId)).toEqual(['T_FILE', 'T_NONE', undefined]);
    });

    it('counts a thread Manki resolved as dismissed only when the judge marked it addressed', async () => {
      const title = 'Missing null check';
      const slug = titleToSlug(title);
      const files = { human: 'src/human.ts', bot: 'src/bot.ts', judge: 'src/judge.ts', unknown: 'src/unknown.ts', bare: 'src/bare.ts' };
      const entries = Object.values(files).map(file => ({
        fingerprint: { file, lineStart: 10, lineEnd: 10, slug },
        severity: 'blocker' as const,
        title,
      }));
      const ctx = makeRoundContext(1, {
        findings: { count: 5, severityCounts: { blocker: 5, warning: 0, note: 0 }, entries },
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
      // Manki's own resolve settles a blocker only with its record of someone with write access it cleared the thread for.
      const settled = thread('T_BOT', files.bot, 'manki-review');
      settled.comments.nodes.push({ body: 'The caller checks this.', author: { login: 'alice' } }, { body: `**Withdrawn.** The caller checks it.\n\n<!-- manki -->\n${clearRecordMarker('alice')}`, author: { login: BOT_LOGIN } });
      const withWriter = (octokit: ReturnType<typeof mockOctokit>) => {
        // carol's access cannot be read, which counts as none.
        Object.assign(octokit.rest, { repos: { getCollaboratorPermissionLevel: jest.fn(async ({ username }: { username: string }) => {
          if (username === 'carol') throw new Error('API rate limit exceeded');
          return { data: { permission: username === 'alice' ? 'write' : 'none', user: { type: 'User' } } };
        }) } });
        return octokit;
      };
      const octokit = withWriter(mockOctokit([
        thread('T_HUMAN', files.human, 'alice'),
        settled,
        thread('T_JUDGE', files.judge, BOT_LOGIN),
        thread('T_UNKNOWN', files.unknown, null),
        thread('T_BARE', files.bare, BOT_LOGIN),
      ], [
        { id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } },
      ]));

      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      // Manki reopens its own resolve that nothing backs.
      expect(state.previousFindings.map(f => [f.status, f.reopen])).toEqual([
        ['resolved', undefined], ['auto-resolved', undefined], ['resolved', undefined], ['open', undefined], ['open', 'unbacked'],
      ]);
      // A record whose person's access cannot be read leaves the resolve unbacked, but reopens nothing: the lookup may only have failed.
      const unreadAccess = thread('T_BOT', files.bot, BOT_LOGIN);
      unreadAccess.comments.nodes.push({ body: `**Withdrawn.** The caller checks it.\n\n<!-- manki -->\n${clearRecordMarker('carol')}`, author: { login: BOT_LOGIN } });
      const lookupFailed = await fetchRecapState(withWriter(mockOctokit([unreadAccess], [{ id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } }])), TEST_BOT, 'owner', 'repo', 1, 'author');
      expect(lookupFailed.previousFindings.map(f => [f.status, f.reopen])).toEqual([['open', undefined]]);

      // Manki reopens a thread the PR author resolved, and resolves it itself once a maintainer clears it. Its status is the same.
      const cleared = thread('T_BOT', files.bot, BOT_LOGIN);
      cleared.comments.nodes.push(
        { body: `<!-- manki -->\n${REOPENED_MARKER}\nReopened.`, author: { login: BOT_LOGIN } },
        { body: 'The caller checks this.', author: { login: 'alice' } },
        { body: `**Withdrawn.** The caller checks it.\n\n<!-- manki -->\n${clearRecordMarker('alice')}`, author: { login: BOT_LOGIN } },
      );
      const afterClear = await fetchRecapState(withWriter(mockOctokit([cleared], [{ id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } }])), TEST_BOT, 'owner', 'repo', 1, 'author');
      expect(afterClear.previousFindings.map(f => [f.status, f.reopen ?? false])).toEqual([['auto-resolved', false]]);

      // Manki's answer decided the thread without a fix only when its record says it accepted no fix and no answer of
      // Manki's accepted or confirmed one. An answer without a readable record proves nothing.
      const answer = (outcome: ReplyDecision['outcome']) => `**${outcome}.** The caller checks it.\n\n<!-- manki -->\n${formatReplyRecord({
        kind: 'thread-reply', prNumber: 1, timestamp: '2026-11-18T10:00:00Z', mankiVersion: '7.7.0', usage: {}, decision: { outcome, thread: 'resolves' },
      })}`;
      const confirmed = `Fixed by the commits up to abc1234.\n\n<!-- manki -->\n${fixedMarker('a'.repeat(40))}`;
      const answeredWith = (id: string, path: string, replies: string[], people: Array<[string, string]> = [['alice', 'The caller checks this.']]) => {
        const answered = thread(id, path, BOT_LOGIN);
        // Manki's last comment records that it cleared the thread for alice, who has write access, so its resolve is backed and the thread is `auto-resolved`.
        const record = `<!-- manki -->\n${clearRecordMarker('alice')}`;
        answered.comments.nodes.push(...people.map(([login, body]) => ({ body, author: { login } })), ...[...replies, record].map(body => ({ body, author: { login: BOT_LOGIN } })));
        return answered;
      };
      // Only Manki's own comments count. No person's text does, a dismiss command or a reply record a person typed
      // included, whoever wrote it.
      const typedRecord = answer('Agreed').replace('**Agreed.**', 'Agreed, see below.');
      const dismissed: Array<[string, string]> = [['alice', '@manki dismiss']];
      const decided: Array<[string, string[], Array<[string, string]> | undefined, boolean]> = [
        ['waived', [answer('Withdrawn')], undefined, true], ['agreed', [answer('Agreed')], undefined, true],
        ['ticked Dismiss box', [answer('Agreed').replace('**Agreed.** The caller checks it.', 'Dismissed by `@alice`.')], undefined, true], ['fixed', [answer('Fixed')], undefined, false],
        ['fix confirmed later', [answer('Agreed'), confirmed], undefined, false], ['no record', ['**Withdrawn.** The caller checks it.\n\n<!-- manki -->'], undefined, false],
        ['dismiss without write access', [], [['mallory', '@manki dismiss'], ['alice', 'The caller checks this.']], false],
        ['dismiss whose access cannot be read', [], [['carol', '@manki dismiss'], ['alice', 'The caller checks this.']], false],
        ['record typed by a person', [], [['alice', typedRecord]], false],
        ['dismiss by a writer', ['Dismissed: the null check.\n\n<!-- manki -->'], dismissed, false],
        ['dismiss Manki recorded', [`Finding dismissed by \`@alice\`, who has write access to this repository.\n\n<!-- manki -->\n${dismissRecordMarker('alice')}`], dismissed, true],
        ['dismiss then confirmed fix', [confirmed], dismissed, false],
        // A reopen by Manki ends the waiver before it, and only a waiver after it counts.
        ['waived, then reopened', [answer('Withdrawn'), `Reopened.\n\n<!-- manki -->\n${REOPENED_MARKER}`], undefined, false],
        ['reopened, then waived', [`Reopened.\n\n<!-- manki -->\n${REOPENED_MARKER}`, answer('Withdrawn')], undefined, true],
        // So does a raise, which moves the finding to another thread.
        ['waived, then raised', [answer('Withdrawn'), `Raised to a blocker, continued in [this thread](https://github.com/o/r/pull/1#discussion_T2).\n\n<!-- manki -->\n${RAISED_MARKER}`], undefined, false],
      ];
      for (const [why, replies, people, without] of decided) {
        const read = await fetchRecapState(withWriter(mockOctokit([answeredWith('T_BOT', files.bot, replies, people)], [{ id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } }])), TEST_BOT, 'owner', 'repo', 1, 'author');
        expect([why, read.previousFindings.map(f => [f.status, f.decidedWithoutFix ?? false])]).toEqual([why, [['auto-resolved', without]]]);
      }
      // A raise ends every answer before it too, so no repeat goes back to the thread as answered there, and no filed issue
      // is listed from it. The thread is marked raised, so it carries no later finding either.
      const filed = '**Agreed.** Filed as #12 for later work.\n\n<!-- manki -->\n<!-- manki-tracked -->';
      const raisedReply = `Raised to a blocker, continued in [this thread](https://github.com/o/r/pull/1#discussion_T2).\n\n<!-- manki -->\n${RAISED_MARKER}`;
      for (const [why, replies, kept] of [
        ['not raised', [filed, answer('Withdrawn')], ['**Withdrawn.** The caller checks it.', 12, undefined]],
        ['raised', [filed, answer('Withdrawn'), raisedReply], [undefined, undefined, true]],
      ] as Array<[string, string[], [string | undefined, number | undefined, true | undefined]]>) {
        const read = await fetchRecapState(withWriter(mockOctokit([answeredWith('T_BOT', files.bot, replies)], [{ id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } }])), TEST_BOT, 'owner', 'repo', 1, 'author');
        expect([why, read.previousFindings.map(f => [f.answer, f.filedIssue, f.raised])]).toEqual([why, [kept]]);
      }
      // A dismiss command after Manki's answer cancels nothing, whoever sent it.
      const dismissedLater = answeredWith('T_BOT', files.bot, [answer('Withdrawn')]);
      dismissedLater.comments.nodes.push({ body: '@manki dismiss', author: { login: 'mallory' } });
      const afterDismiss = await fetchRecapState(withWriter(mockOctokit([dismissedLater], [{ id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } }])), TEST_BOT, 'owner', 'repo', 1, 'author');
      expect(afterDismiss.previousFindings.map(f => f.decidedWithoutFix ?? false)).toEqual([true]);
      // A waiver by Manki's answer keeps the lines of the PR the answer cited, without those of a related repo. Any other waiver cites none.
      const cited = answer('Agreed').replace(formatReplyRecord({
        kind: 'thread-reply', prNumber: 1, timestamp: '2026-11-18T10:00:00Z', mankiVersion: '7.7.0', usage: {}, decision: { outcome: 'Agreed', thread: 'resolves' },
      }), formatReplyRecord({
        kind: 'thread-reply', prNumber: 1, timestamp: '2026-11-18T10:00:00Z', mankiVersion: '7.7.0', usage: {}, decision: { outcome: 'Agreed', thread: 'resolves' },
        statements: [{ status: 'confirmed', places: ['src/a.ts:40-42', 'org/lib:src/b.ts:7'] }, { status: 'confirmed', places: ['src/c.ts:5'] }],
      }));
      const settledOf = async (replies: string[], people?: Array<[string, string]>) =>
        (await fetchRecapState(withWriter(mockOctokit([answeredWith('T_BOT', files.bot, replies, people)], [{ id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } }])), TEST_BOT, 'owner', 'repo', 1, 'author')).previousFindings;
      const placesOf = async (replies: string[], people?: Array<[string, string]>) => (await settledOf(replies, people)).map(f => f.answerPlaces);
      expect(await placesOf([cited])).toEqual([['src/a.ts:40-42', 'src/c.ts:5']]);
      // A statement that rests on a search, the PR description or a related repo alone cites no line of the PR, so a push anywhere may change it.
      for (const statement of [{ status: 'confirmed' as const, places: [], searched: 'pr' }, { status: 'confirmed' as const, description: 'held' as const }, { status: 'confirmed' as const, places: ['org/lib:src/b.ts:7'] }]) {
        const unsure = answer('Agreed').replace(formatReplyRecord({
          kind: 'thread-reply', prNumber: 1, timestamp: '2026-11-18T10:00:00Z', mankiVersion: '7.7.0', usage: {}, decision: { outcome: 'Agreed', thread: 'resolves' },
        }), formatReplyRecord({
          kind: 'thread-reply', prNumber: 1, timestamp: '2026-11-18T10:00:00Z', mankiVersion: '7.7.0', usage: {}, decision: { outcome: 'Agreed', thread: 'resolves' },
          statements: [{ status: 'confirmed', places: ['src/a.ts:40-42'] }, statement],
        }));
        expect(await placesOf([unsure])).toEqual([undefined]);
      }
      // So does an answer that left a statement of the reply unchecked or dropped.
      for (const left of [{ uncheckedStatements: 1 }, { droppedStatements: 1 }]) {
        const partial = answer('Agreed').replace(formatReplyRecord({
          kind: 'thread-reply', prNumber: 1, timestamp: '2026-11-18T10:00:00Z', mankiVersion: '7.7.0', usage: {}, decision: { outcome: 'Agreed', thread: 'resolves' },
        }), formatReplyRecord({
          kind: 'thread-reply', prNumber: 1, timestamp: '2026-11-18T10:00:00Z', mankiVersion: '7.7.0', usage: {}, decision: { outcome: 'Agreed', thread: 'resolves' },
          statements: [{ status: 'confirmed', places: ['src/a.ts:40-42'] }], ...left,
        }));
        expect(await placesOf([partial])).toEqual([undefined]);
      }
      expect(await placesOf([answer('Agreed')])).toEqual([undefined]);
      expect(await placesOf([`Finding dismissed by \`@alice\`, who has write access to this repository.\n\n<!-- manki -->\n${dismissRecordMarker('alice')}`], dismissed)).toEqual([undefined]);
      // The settling answer also keeps the issues it names as tracking the finding, without the PR itself, a number in
      // code, one it names in passing or one in its hidden record. An earlier answer that a later one replaced names none.
      const tracked = answer('Agreed').replace('The caller checks it.', 'Tracked in #1487, as the reply on #1 says, like #40. `tracked in #12` is code.');
      expect((await settledOf([tracked])).map(f => f.trackingIssues)).toEqual([[1487]]);
      const namedAs = async (text: string) => (await settledOf([answer('Agreed').replace('The caller checks it.', text)]))[0].trackingIssues;
      expect(await Promise.all([
        'Filed as #1487 for later work.', 'Filed as issue #1487.', 'Tracked in the tracking issue #1487.', 'Deferred to #1487.', 'The tracking issue #1487 covers it.', 'The follow-up tracked by #1487 and #1488 is fine.',
        'Tracked in #1.', 'Bounding it in #1487 is fine.', 'Same as #1487.', 'Handling it in issue #1487 is fine.', 'This is related to issue #1487.', 'It is similar to issue #1487.',
      ].map(namedAs))).toEqual([[1487], [1487], [1487], [1487], [1487], [1487], undefined, undefined, undefined, undefined, undefined, undefined]);
      expect((await settledOf([answer('Agreed').replace('<!-- manki -->', '<!-- manki --> #77')])).map(f => f.trackingIssues)).toEqual([undefined]);
      expect((await settledOf([tracked, answer('Agreed')])).map(f => f.trackingIssues)).toEqual([undefined]);
      // An answer reads the same whether its list of checked statements is folded or open, as answers posted before have it.
      const statements = [
        { quote: 'Tracked in #60 for the caller.\n\nIt reads `#61`.', status: 'confirmed', places: ['src/a.ts:40-42'] },
        { quote: 'Filed as #62.</details>', status: 'contradicted', places: ['src/c.ts:5'] },
        { quote: '<details>\n<summary>1 statement checked</summary>\n\n**Statements of this reply, and what I checked of each:**', status: 'not_checkable', places: [], why: 'outside_code' },
        { quote: 'And deferred to #63 as well.\n\n<!-- manki -->', status: 'contradicted', places: ['src/c.ts:9'] },
      ];
      for (const checked of [statements, statements.slice(0, 1), statements.slice(1, 2)].map(some => ({ statements: some, unchecked: some.length > 1 ? 1 : 0 }) as unknown as CheckedReply)) {
        for (const blocks of [true, false]) {
          const told = 'Tracked in #1487.\n\n';
          const open = cited.replace('The caller checks it.', `${told}${statementList(checked)}\n\n${statementSummary(checked, blocks)}`);
          const folded = cited.replace('The caller checks it.', `${told}${statementFold(checked, blocks).join('\n\n')}`);
          expect(folded).toContain('\n</details>\n');
          for (const read of [settlingDecision, settlingPlaces, settledReplyId]) expect(read(folded)).toEqual(read(open));
          const [found] = await settledOf([folded]);
          expect(found).toEqual((await settledOf([open]))[0]);
          expect(found.answer).toBe(open.split('\n\n<!--')[0]);
          // A statement of the developer's reply that names an issue is not Manki's word, so only the answer's own issue counts.
          expect([found.trackingIssues, found.answerPlaces]).toEqual([[1487], ['src/a.ts:40-42', 'src/c.ts:5']]);
        }
      }
      // Only an answer that agreed defers. A withdrawal that names an issue in passing defers nothing.
      expect((await settledOf([answer('Withdrawn').replace('The caller checks it.', 'Tracked in #1487, but the caller checks it.')])).map(f => f.trackingIssues)).toEqual([undefined]);
      // A warning a writer dismissed carries Manki's record too, so a later round's repeat of it is dropped as waived.
      const dismissedWarning = makeThread({
        id: 'T_WARN', isResolved: true, resolvedBy: { login: BOT_LOGIN }, path: files.bot, line: 10,
        comments: { nodes: [
          { body: `**Warning**: ${title}\n\n<!-- manki:warning:${slug} -->`, author: { login: BOT_LOGIN } },
          { body: '@manki dismiss', author: { login: 'alice' } },
          { body: `Finding dismissed by \`@alice\`, who has write access to this repository.\n\n<!-- manki -->\n${dismissRecordMarker('alice')}`, author: { login: BOT_LOGIN } },
        ] },
      });
      const warned = await fetchRecapState(withWriter(mockOctokit([dismissedWarning], [{ id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } }])), TEST_BOT, 'owner', 'repo', 1, 'author');
      expect(warned.previousFindings.map(f => [f.status, f.decidedWithoutFix ?? false])).toEqual([['auto-resolved', true]]);
      const sameDefect = { sendMessage: jest.fn().mockResolvedValue({ content: '[{ "index": 1, "matchedResolved": 1 }]' }) } as unknown as import('./providers').LLMClient;
      const repeat = makeFinding({ severity: 'warning', title: 'Null input is not rejected', file: files.bot, line: 10 });
      const deduped = await llmDeduplicateFindings([repeat], warned.previousFindings, sameDefect, undefined, () => false);
      expect([deduped.unique, deduped.duplicates.map(d => d.matchedTitle)]).toEqual([[], [title]]);

      // A later round that found the thread open again takes the earlier `addressed` away, so Manki's resolve has nothing
      // to back it. A warning thread Manki resolved on an `addressed` record counts as resolved and fixed.
      const laterCtx = makeRoundContext(2, { judge: { summary: 'ok', threadEvaluations: [
        { threadId: 'T_JUDGE', status: 'not_addressed', reason: 'The check is gone again.' }, { threadId: 'T_WARN', status: 'addressed', reason: 'fixed' },
      ] } });
      const warning = makeThread({
        id: 'T_WARN', isResolved: true, resolvedBy: { login: BOT_LOGIN }, path: 'src/warn.ts', line: 10,
        comments: { nodes: [{ body: `**Warning**: ${title}\n\n<!-- manki:warning:${slug} -->`, author: { login: BOT_LOGIN } }] },
      });
      const later = await fetchRecapState(mockOctokit(
        [thread('T_JUDGE', files.judge, BOT_LOGIN), warning],
        [ctx, laterCtx].map((record, i) => ({ id: 100 + i, body: htmlCommentBlock(record), user: { login: BOT_LOGIN } })),
      ), TEST_BOT, 'owner', 'repo', 1);
      // Manki reopens that thread, since it still counts it as open.
      expect(later.previousFindings.map(f => [f.status, f.fixed ?? false, f.reopen])).toEqual([['open', false, 'unbacked'], ['resolved', true, undefined]]);
      // A thread a round's judge once found fixed is never decided without a fix, whatever the answer after it says.
      const onceFixed = await fetchRecapState(withWriter(mockOctokit(
        [answeredWith('T_JUDGE', files.judge, [answer('Withdrawn')])],
        [ctx, laterCtx].map((record, i) => ({ id: 100 + i, body: htmlCommentBlock(record), user: { login: BOT_LOGIN } })),
      )), TEST_BOT, 'owner', 'repo', 1, 'author');
      expect(onceFixed.previousFindings.map(f => [f.status, f.decidedWithoutFix ?? false])).toEqual([['auto-resolved', false]]);
      expect(state.previousFindings.map(f => f.fixed ?? false)).toEqual([false, false, true, false, false]);

      const newFindings = Object.values(files).map(file => makeFinding({ title, file, line: 10 }));
      const { unique } = deduplicateFindings(newFindings, state.previousFindings);
      expect(unique.map(f => f.file)).toEqual([files.bot, files.judge, files.unknown, files.bare]);
      expect(unique[1].resemblesFixed).toEqual({ title, file: files.judge, line: 10 });
      expect(collectInPrSuppressions(state.previousFindings).map(s => s.fingerprint.file)).toEqual([files.human]);
      const resolvedThreadIds = collectResolvedThreadIds(state.previousFindings);
      expect(resolvedThreadIds).toEqual(new Set(['T_HUMAN', 'T_JUDGE']));
      const ratcheted = applyCrossRoundSuppression(newFindings, state.priorRounds, { resolvedThreadIds });
      expect(ratcheted.findings.filter(f => f.severity !== 'ignore').map(f => f.file)).toEqual([files.bot, files.unknown, files.bare]);

      const judgePrior = state.priorRounds[0].findings.entries.filter(e => e.threadId === 'T_JUDGE');
      expect(judgePrior).toHaveLength(1);
      expect(determineOutcome([], judgePrior, [], resolvedThreadIds).outcome).toBe('READY');
    });

    it('keeps a blocking or security finding blocking until someone other than the PR author dismisses it', async () => {
      const title = 'Token leaks into logs';
      const slug = titleToSlug(title);
      // `answer`: how Manki answered the reply, as its reply record or its record of a dismissal says.
      // `dismissedBy`: whose dismissal Manki recorded, when not the reply's writer.
      // `cleared`: who Manki's record after the reply says it cleared the thread for.
      type Case = { resolver?: string; reply?: { login: string; association: string; text?: string; answer?: ReplyDecision['thread'] | 'dismiss'; dismissedBy?: string }; cleared?: string; reopened?: boolean; foundAgain?: boolean; dismissed?: boolean; security: boolean; blocker?: boolean; blocks: boolean };
      const bounded = 'Every caller bounds both inputs.';
      const cases: Record<string, Case> = {
        // A Manki reply that quotes the fix does not count as a reopen.
        'src/author-resolved.ts': { resolver: 'author', foundAgain: true, security: true, blocks: true },
        // A recorded override counts only once GitHub confirms the PR author's role, since a Manki reply can echo any text.
        'src/author-dismissed.ts': { resolver: BOT_LOGIN, dismissed: true, security: true, blocks: true },
        'src/bot-resolved.ts': { resolver: BOT_LOGIN, security: true, blocks: true },
        'src/author-resolved-again.ts': { resolver: 'author', reopened: true, security: true, blocks: true },
        'src/author-agreed.ts': { reply: { login: 'author', association: 'OWNER', answer: 'stays_open' }, security: true, blocks: true },
        'src/outsider-agreed.ts': { reply: { login: 'carol', association: 'CONTRIBUTOR', answer: 'no_permission' }, security: true, blocks: true },
        'src/collaborator-resolved.ts': { resolver: 'alice', security: true, blocks: false },
        'src/collaborator-agreed.ts': { reply: { login: 'bob', association: 'MEMBER', answer: 'resolves' }, security: true, blocks: false },
        // Agreeing needs Manki's answer, so a reply it has not answered yet leaves the thread blocking.
        'src/collaborator-unanswered.ts': { reply: { login: 'bob', association: 'MEMBER' }, security: true, blocks: true },
        'src/collaborator-dismissed.ts': { resolver: BOT_LOGIN, reply: { login: 'bob', association: 'MEMBER', text: '@manki dismiss', answer: 'dismiss' }, security: true, blocks: false },
        // A dismissal Manki recorded for the PR author agrees to nothing for the maintainer whose reply came before it.
        'src/collaborator-reply-author-dismissed.ts': { reply: { login: 'bob', association: 'MEMBER', answer: 'dismiss', dismissedBy: 'author' }, security: true, blocks: true },
        // Manki's own resolve settles a security thread only with its record of someone who may clear it, whatever a reply says.
        'src/collaborator-settled.ts': { resolver: BOT_LOGIN, reply: { login: 'bob', association: 'MEMBER', text: bounded }, cleared: 'bob', security: true, blocks: false },
        'src/collaborator-reply-only.ts': { resolver: BOT_LOGIN, reply: { login: 'bob', association: 'MEMBER', text: bounded }, security: true, blocks: true },
        'src/author-settled.ts': { resolver: BOT_LOGIN, reply: { login: 'author', association: 'OWNER', text: bounded }, cleared: 'author', security: true, blocks: true },
        'src/reader-settled.ts': { resolver: BOT_LOGIN, reply: { login: 'dave', association: 'MEMBER', text: bounded }, cleared: 'dave', security: true, blocks: true },
        // Such a record does not make the PR author's own resolve count.
        'src/author-resolved-after-reply.ts': { resolver: 'author', reopened: true, reply: { login: 'bob', association: 'MEMBER', text: bounded }, cleared: 'bob', security: true, blocks: true },
        // `MEMBER` covers an org member with read access, so write access comes from the API.
        'src/reader-agreed.ts': { reply: { login: 'dave', association: 'MEMBER', answer: 'no_permission' }, security: true, blocks: true },
        // A private org member shows as `NONE`.
        'src/private-member-agreed.ts': { reply: { login: 'erin', association: 'NONE', answer: 'resolves' }, security: true, blocks: false },
        'src/judge-addressed.ts': { resolver: BOT_LOGIN, security: true, blocks: false },
        // The record backs only Manki's own resolve, so the PR author resolving the thread later does not clear it.
        'src/judge-addressed-author-resolved.ts': { resolver: 'author', security: true, blocks: true },
        'src/plain-author-resolved.ts': { resolver: 'author', security: false, blocks: false },
        'src/plain-author-agreed.ts': { reply: { login: 'author', association: 'NONE', answer: 'resolves' }, security: false, blocks: false },
        'src/blocker-author-resolved.ts': { resolver: 'author', security: false, blocker: true, blocks: true },
        'src/blocker-author-agreed.ts': { reply: { login: 'author', association: 'OWNER', answer: 'stays_open' }, security: false, blocker: true, blocks: true },
        'src/blocker-collaborator-resolved.ts': { resolver: 'alice', security: false, blocker: true, blocks: false },
        // A blocker thread follows the same rule as a security thread: Manki's own resolve alone settles nothing.
        'src/blocker-bot-resolved.ts': { resolver: BOT_LOGIN, security: false, blocker: true, blocks: true },
        'src/blocker-collaborator-settled.ts': { resolver: BOT_LOGIN, reply: { login: 'bob', association: 'MEMBER', text: bounded }, cleared: 'bob', security: false, blocker: true, blocks: false },
        // GraphQL types every resolver as `User`. Only the permission lookup tells that a workflow token is no person,
        // under either login GitHub could name it by.
        'src/workflow-resolved.ts': { resolver: 'github-actions[bot]', security: true, blocks: true },
        'src/blocker-workflow-resolved.ts': { resolver: 'github-actions[bot]', security: false, blocker: true, blocks: true },
        'src/bare-workflow-resolved.ts': { resolver: 'github-actions', security: true, blocks: true },
        'src/blocker-bare-workflow-resolved.ts': { resolver: 'github-actions', security: false, blocker: true, blocks: true },
        // A person clears by resolving only with write access.
        'src/blocker-reader-resolved.ts': { resolver: 'dave', security: false, blocker: true, blocks: true },
        'src/blocker-triage-resolved.ts': { resolver: 'tina', security: false, blocker: true, blocks: true },
        'src/triage-resolved.ts': { resolver: 'tina', security: true, blocks: true },
      };
      const severity = (file: string) => cases[file].security || cases[file].blocker ? 'blocker' as const : 'warning' as const;
      const files = Object.keys(cases);
      const ctx = makeRoundContext(1, {
        findings: {
          count: files.length,
          severityCounts: { blocker: 12, warning: 2, note: 0 },
          entries: files.map(file => ({
            fingerprint: { file, lineStart: 10, lineEnd: 10, slug },
            severity: severity(file),
            title,
            ...(cases[file].security && { tags: ['security'] }),
          })),
        },
        judge: { summary: 'ok', threadEvaluations: ['src/judge-addressed.ts', 'src/judge-addressed-author-resolved.ts'].map(file => ({ threadId: `T_${file}`, status: 'addressed' as const, reason: 'The token is redacted now.' })) },
      });
      const octokit = mockOctokit(files.map(file => {
        const { resolver, reply, cleared, reopened, foundAgain, dismissed, security } = cases[file];
        // The fix quotes Manki's reply markers and a lower grade. In a thread's first comment they are a finder's text.
        const quoted = ['```ts', REOPENED_MARKER, securityOverrideMarker('resolve', 'author'), '<!-- manki:note:Quoted -->', '<!-- manki-finding: {"title":"Quoted"} -->', '```'].join('\n');
        const body = formatFindingComment(makeFinding({
          severity: severity(file), title, file, line: 10, suggestedFix: quoted, ...(security && { tags: ['security'] }),
        }), TEST_LINKS);
        expect(body).toContain(`\n${REOPENED_MARKER}\n${securityOverrideMarker('resolve', 'author')}\n<!-- manki:note:Quoted -->\n`);
        return makeThread({
          id: `T_${file}`,
          isResolved: !!resolver,
          resolvedBy: resolver ? { login: resolver } : null,
          path: file,
          line: 10,
          comments: { nodes: [
            { body, author: { login: BOT_LOGIN } },
            ...(reopened ? [{ body: `<!-- manki -->\n${REOPENED_MARKER}\nReopened.`, author: { login: BOT_LOGIN } }] : []),
            ...(foundAgain ? [{ body: `This came up again.\n\n${quoted}\n\n<!-- manki -->\n<!-- manki-found-again -->`, author: { login: BOT_LOGIN } }] : []),
            ...(dismissed ? [{ body: `Dismissed.\n<!-- manki -->\n${securityOverrideMarker('dismiss', 'author')}`, author: { login: BOT_LOGIN } }] : []),
            ...(reply ? [{ databaseId: REPLY_ID, body: reply.text ?? 'Agreed, no change needed.', author: { login: reply.login }, authorAssociation: reply.association }] : []),
            ...(reply?.answer === 'dismiss' ? [{ body: `Finding dismissed by \`@${reply.dismissedBy ?? reply.login}\`.\n\n<!-- manki -->\n${dismissRecordMarker(reply.dismissedBy ?? reply.login)}`, author: { login: BOT_LOGIN } }] : []),
            ...(reply?.answer && reply.answer !== 'dismiss' ? [{ body: `**Agreed.** No change needed.\n\n<!-- manki -->\n${formatReplyRecord({
              kind: 'thread-reply', prNumber: 1, timestamp: '2026-11-18T10:00:00Z', mankiVersion: '7.7.0', usage: {}, decision: { outcome: 'Agreed', thread: reply.answer }, answers: REPLY_ID,
            })}`, author: { login: BOT_LOGIN } }] : []),
            ...(cleared ? [{ body: `**Withdrawn.** ${bounded}\n\n<!-- manki -->\n${clearRecordMarker(cleared)}`, author: { login: BOT_LOGIN } }] : []),
          ] },
        });
      }), [{ id: 100, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } }]);
      // Each login's `role_name`. The legacy `permission` beside it reports `maintain` as `write`.
      const roles: Record<string, string> = { author: 'write', alice: 'write', bob: 'write', dave: 'read', erin: 'write', tina: 'triage' };
      const legacy: Record<string, string> = { admin: 'admin', maintain: 'write', write: 'write', triage: 'read', read: 'read' };
      // GitHub answers for a bot account with its type and no permission, and with a 404 for the bare `github-actions`.
      const permission = jest.fn(async ({ username }: { username: string }) => {
        if (username === 'github-actions') throw new Error('github-actions is not a user');
        if (username.endsWith('[bot]')) return { data: { permission: 'none', role_name: '', user: { type: 'Bot' } } };
        return { data: roles[username] ? { permission: legacy[roles[username]], role_name: roles[username], user: { type: 'User' } } : { permission: 'none' } };
      });
      Object.assign(octokit.rest, { repos: { getCollaboratorPermissionLevel: permission } });

      // The author can push, which is below the default level `maintain`, so their own resolve clears nothing.
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1, 'author', 'maintain');
      // Manki also reopens a thread it resolved with no record behind it, as for a maintainer's reply before the clear
      // records. A record whose person cannot clear the thread reopens nothing, since a failed lookup reads the same.
      expect(state.previousFindings.filter(f => f.reopen).map(f => [f.file, f.reopen])).toEqual([
        ['src/author-resolved.ts', 'author'], ['src/bot-resolved.ts', 'unbacked'], ['src/collaborator-reply-only.ts', 'unbacked'],
        ['src/judge-addressed-author-resolved.ts', 'author'], ['src/blocker-author-resolved.ts', 'author'], ['src/blocker-bot-resolved.ts', 'unbacked'],
      ]);
      expect(state.previousFindings.filter(f => f.securityOverride)).toEqual([]);
      // A thread someone with write access agreed away stays `replied`. Once Manki resolved it for such a person it is
      // `auto-resolved`: neither open nor dismissed.
      expect(state.previousFindings.filter(f => f.authorReplyMayClear).map(f => [f.file, f.status, replyClassOf(f)])).toEqual([
        ['src/collaborator-agreed.ts', 'replied', 'agree'], ['src/collaborator-unanswered.ts', 'replied', 'none'], ['src/collaborator-dismissed.ts', 'auto-resolved', 'agree'],
        ['src/collaborator-reply-author-dismissed.ts', 'replied', 'none'],
        ['src/collaborator-settled.ts', 'auto-resolved', 'none'], ['src/collaborator-reply-only.ts', 'replied', 'none'], ['src/author-resolved-after-reply.ts', 'replied', 'none'],
        ['src/private-member-agreed.ts', 'replied', 'agree'], ['src/blocker-collaborator-settled.ts', 'auto-resolved', 'none'],
      ]);
      const openThreads = state.previousFindings
        .filter(f => f.status === 'open' || f.status === 'replied')
        .map(f => ({ threadId: f.threadId!, title: f.title, file: f.file, line: f.line, severity: f.severity }));
      const resolvedThreadIds = collectResolvedThreadIds(state.previousFindings);
      const blocking = state.priorRounds[0].findings.entries
        .filter(e => determineOutcome([], [e], openThreads, resolvedThreadIds).outcome === 'ADDRESS_FIRST')
        .map(e => e.fingerprint.file);
      expect(blocking).toEqual(files.filter(file => cases[file].blocks));

      const reRaised = files.map(file => makeFinding({ severity: 'blocker', title, file, line: 10 }));
      // A settled thread suppresses nothing, since nobody agreed its finding away: a finding raised again is posted.
      expect(collectInPrSuppressions(state.previousFindings, 'author').map(s => s.fingerprint.file))
        .toEqual(files.filter(file => !cases[file].blocks && file !== 'src/judge-addressed.ts' && !file.endsWith('collaborator-settled.ts')));
      // Dedup drops a blocker only on a resolved blocking or security thread not confirmed fixed. An agreed thread is dropped by the in-PR suppressions above.
      expect(deduplicateFindings(reRaised, state.previousFindings).unique.map(f => f.file))
        .toEqual(files.filter(file => cases[file].blocks || cases[file].reply || severity(file) === 'warning' || file === 'src/judge-addressed.ts'));

      // With the PR author unknown, any human resolver has write access, so a human resolution clears the thread.
      const unknownAuthor = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1);
      expect(unknownAuthor.previousFindings.filter(f => f.isSecurity && f.status === 'resolved').map(f => f.file))
        .toEqual(['src/author-resolved.ts', 'src/author-resolved-again.ts', 'src/collaborator-resolved.ts', 'src/author-resolved-after-reply.ts', 'src/judge-addressed.ts', 'src/judge-addressed-author-resolved.ts']);

      // Only a reply Manki settled agrees a security thread away under the same fallback, so the PR author's reply it kept open does not.
      expect(collectInPrSuppressions(unknownAuthor.previousFindings).filter(s => s.reason === 'agree-reply').map(s => s.fingerprint.file))
        .toEqual(['src/collaborator-agreed.ts', 'src/collaborator-dismissed.ts', 'src/private-member-agreed.ts']);

      // An author with the `maintain` role clears their own resolved threads at that level. Nothing is reopened, and the override waits for Manki's reply.
      // Permissions are cached per client, so each lookup of a changed role needs a fresh one.
      roles.author = 'maintain';
      const admin = Object.create(octokit);
      const adminState = await fetchRecapState(admin, TEST_BOT, 'owner', 'repo', 1, 'author', 'maintain');
      expect(adminState.previousFindings.filter(f => f.reopen === 'author')).toEqual([]);
      expect(adminState.previousFindings.filter(f => f.securityOverride).map(f => [f.file, f.securityOverride])).toEqual([
        ['src/author-resolved.ts', { login: 'author', via: 'resolve', role: 'maintain', announced: false }],
        ['src/author-dismissed.ts', { login: 'author', via: 'dismiss', role: 'maintain', announced: true }],
        ['src/author-resolved-again.ts', { login: 'author', via: 'resolve', role: 'maintain', announced: false }],
        ['src/author-resolved-after-reply.ts', { login: 'author', via: 'resolve', role: 'maintain', announced: false }],
        ['src/judge-addressed-author-resolved.ts', { login: 'author', via: 'resolve', role: 'maintain', announced: false }],
        ['src/blocker-author-resolved.ts', { login: 'author', via: 'resolve', role: 'maintain', announced: false }],
      ]);
      // The same author clears nothing where the repository asks for `admin`, or where no level is known. The threads are reopened as for any author.
      for (const level of ['admin', undefined] as const) {
        const below = await fetchRecapState(Object.create(octokit), TEST_BOT, 'owner', 'repo', 1, 'author', level);
        expect([level, below.previousFindings.filter(f => f.securityOverride), below.previousFindings.filter(f => f.reopen === 'author').map(f => f.file)])
          .toEqual([level, [], ['src/author-resolved.ts', 'src/judge-addressed-author-resolved.ts', 'src/blocker-author-resolved.ts']]);
      }
      const adminOpen = adminState.previousFindings.filter(f => f.status === 'open' || f.status === 'replied')
        .map(f => ({ threadId: f.threadId!, title: f.title, file: f.file, line: f.line, severity: f.severity }));
      expect(adminState.priorRounds[0].findings.entries
        .filter(e => determineOutcome([], [e], adminOpen, collectResolvedThreadIds(adminState.previousFindings)).outcome === 'ADDRESS_FIRST')
        .map(e => e.fingerprint.file))
        .toEqual(files.filter(file => cases[file].blocks && !['src/author-resolved.ts', 'src/author-dismissed.ts', 'src/author-resolved-again.ts', 'src/author-resolved-after-reply.ts', 'src/judge-addressed-author-resolved.ts', 'src/blocker-author-resolved.ts'].includes(file)));
      // A second read on the same client does not ask GitHub again.
      const lookups = permission.mock.calls.length;
      await fetchRecapState(admin, TEST_BOT, 'owner', 'repo', 1, 'author', 'maintain');
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
        findings: { count: 1, severityCounts: { blocker: 0, warning: 1, note: 0 }, entries: [entry] },
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
        severity: 'note' as const,
        specialist: 'Style',
        suggestedFix: 'Remove the unused `path` import.',
        title: 'Unused import',
      };
      const ctx = makeRoundContext(2, {
        findings: { count: 1, severityCounts: { blocker: 0, warning: 0, note: 1 }, entries: [entry] },
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

    it('reads a PR with an incomplete round among complete ones like one with only the complete rounds', async () => {
      const first = makeRoundContext(1, { findings: { count: 1, severityCounts: {}, entries: [makeFindingFingerprintEntry({ severity: 'warning', threadId: 'thread-1' })] } });
      const second = makeRoundContext(2, { judge: { summary: 'second round' } });
      // The incomplete round took the number the next complete round gets. Read as a round, it would raise and settle the thread.
      const incomplete = (round: number) => makeRoundContext(round, {
        meta: { prNumber: 1, commitSha: 'failed', round, timestamp: 't', mankiVersion: '7', outcome: 'INCOMPLETE', incomplete: true },
        findings: { count: 1, severityCounts: {}, entries: [makeFindingFingerprintEntry({ severity: 'blocker', threadId: 'thread-1' })] },
        judge: { summary: 'failed round', threadEvaluations: [{ threadId: 'thread-1', status: 'addressed', reason: 'fixed' }] },
      });
      const review = (id: number, ctx: RoundContext | string) => ({ id, node_id: `R_${id}`, body: typeof ctx === 'string' ? ctx : htmlCommentBlock(ctx), user: { login: BOT_LOGIN } });
      const state = (reviews: ReturnType<typeof review>[]) => fetchRecapState(mockOctokit([makeThread()], reviews), TEST_BOT, 'owner', 'repo', 1);
      const complete = await state([review(10, first), review(30, second)]);
      expect(complete.priorRounds.map(r => [r.meta.round, r.meta.commitSha])).toEqual([[1, first.meta.commitSha], [2, second.meta.commitSha]]);

      for (const reviews of [
        [review(10, first), review(20, incomplete(2)), review(30, second)],
        [review(5, incomplete(1)), review(10, first), review(30, second)],
      ]) {
        expect(await state(reviews)).toEqual(complete);
      }
      // Posted last, under a number a complete round has or under the next one, it is the attempt a retry may start from.
      for (const round of [2, 3]) {
        expect(await state([review(10, first), review(30, second), review(40, incomplete(round))])).toEqual({ ...complete, lastAttempt: { record: incomplete(round), review: 40, nodeId: 'R_40' } });
      }
      // A skipped record is neither unread nor a duplicate.
      expect(complete.priorRoundsIncomplete).toBeUndefined();
      expect(core.warning).not.toHaveBeenCalled();
      // A newer record that does not read leaves no such attempt.
      expect((await state([review(40, incomplete(3)), review(50, '<!-- manki-context: {not json} -->')])).lastAttempt).toBeUndefined();
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
      const resolvedByAuthor = makeThread({
        id: 'tw', isResolved: true, resolvedBy: { login: 'author' },
        comments: { nodes: [{ body: '<!-- manki:warning:Bug --> **Warning**: Bug found\n\nDesc.', author: { login: BOT_LOGIN } }] },
      });
      const agreedByAuthor = makeThread({
        id: 'ta', path: 'src/other.ts',
        comments: { nodes: [
          { body: '<!-- manki:warning:Bug --> **Warning**: Bug found\n\nDesc.', author: { login: BOT_LOGIN } },
          { body: 'Agreed, no change needed.', author: { login: 'author' } },
        ] },
      });
      const resolvedByCollaborator = makeThread({
        id: 'tc', isResolved: true, resolvedBy: { login: 'alice' }, path: 'src/c.ts', line: 4,
        comments: { nodes: [{ body: '<!-- manki:warning:Stale-cache --> **Warning**: Stale cache\n\nDesc.', author: { login: BOT_LOGIN } }] },
      });
      const resolvedByManki = makeThread({
        id: 'tm', isResolved: true, resolvedBy: { login: BOT_LOGIN }, path: 'src/m.ts', line: 6,
        comments: { nodes: [{ body: '<!-- manki:warning:Slow-loop --> **Warning**: Slow loop\n\nDesc.', author: { login: BOT_LOGIN } }] },
      });
      const octokit = mockOctokit([resolvedByAuthor, agreedByAuthor, resolvedByCollaborator, resolvedByManki], [
        { id: 500, body: malformed, user: { login: BOT_LOGIN } },
        { id: 501, body: htmlCommentBlock(ctx3), user: { login: BOT_LOGIN } },
      ]);
      const state = await fetchRecapState(octokit, TEST_BOT, 'owner', 'repo', 1, 'author');
      // The skipped record may have raised the threads, so neither the PR author's resolution nor agreement clears them,
      // and neither does Manki's own resolve with nothing to back it, as in the approval check.
      // Manki's resolve is not reopened, since the unread record may back it.
      expect(state.previousFindings.map(f => [f.status, f.reopen, f.gradeUnknown])).toEqual([['open', 'author', true], ['replied', undefined, true], ['resolved', undefined, true], ['open', undefined, true]]);
      expect(collectInPrSuppressions(state.previousFindings, 'author').map(s => s.fingerprint.file)).toEqual(['src/c.ts']);
      // An unknown grade never makes a resolution count as someone else's, so a new blocker there still reaches the judge.
      const repeat = makeFinding({ severity: 'blocker', title: 'Stale cache', file: 'src/c.ts', line: 4 });
      expect(deduplicateFindings([repeat], state.previousFindings).unique).toHaveLength(1);

      // Manki's resolve with its raise reply is backed, since the finding continues in another thread. A thread whose first
      // comment guards it is never raised, so a raise reply there backs nothing.
      const raiseReply = { body: `Raised to a blocker, continued in [this thread](https://github.com/o/r/pull/1#discussion_T2).\n\n<!-- manki -->\n${RAISED_MARKER}`, author: { login: BOT_LOGIN } };
      const raisedThread = (id: string, tags?: string[]) => makeThread({
        id, isResolved: true, resolvedBy: { login: BOT_LOGIN }, path: `src/${id}.ts`, line: 6,
        comments: { nodes: [{ body: formatFindingComment(makeFinding({ severity: 'warning', title: 'Slow loop', file: `src/${id}.ts`, line: 6, ...(tags && { tags }) }), TEST_LINKS), author: { login: BOT_LOGIN } }, raiseReply] },
      });
      const raisedState = await fetchRecapState(mockOctokit([raisedThread('tr'), raisedThread('ts', [SECURITY_TAG])], [
        { id: 500, body: malformed, user: { login: BOT_LOGIN } },
        { id: 501, body: htmlCommentBlock(ctx3), user: { login: BOT_LOGIN } },
      ]), TEST_BOT, 'owner', 'repo', 1, 'author');
      expect(raisedState.previousFindings.map(f => [f.threadId, f.status, f.raised, f.isSecurity ?? false])).toEqual([['tr', 'auto-resolved', true, false], ['ts', 'open', true, true]]);

      // An author whose role allows it still clears their own resolved thread, as with a blocker.
      const admin = Object.create(octokit);
      Object.assign(admin, { rest: { ...octokit.rest, repos: { getCollaboratorPermissionLevel: jest.fn(async () => ({ data: { permission: 'admin', role_name: 'admin', user: { type: 'User' } } })) } } });
      const adminState = await fetchRecapState(admin, TEST_BOT, 'owner', 'repo', 1, 'author', 'maintain');
      expect(adminState.previousFindings.map(f => [f.status, !!f.reopen, f.securityOverride?.login])).toEqual([['resolved', false, 'author'], ['replied', false, undefined], ['resolved', false, undefined], ['open', false, undefined]]);
      expect(state.priorRounds).toHaveLength(1);
      expect(state.priorRounds[0].meta.round).toBe(3);
      // A skipped record could hold a thread's grade, so the recap says the rounds are incomplete, and which review it skipped.
      expect(state.priorRoundsIncomplete).toBe(true);
      expect(state.unreadRecords).toEqual(['https://github.com/owner/repo/pull/1#pullrequestreview-500']);
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
            { databaseId: REPLY_ID, body: 'Fixed in latest push', author: { login: 'author' } },
            { body: recordedAnswer('Fixed'), author: { login: BOT_LOGIN } },
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
            { databaseId: REPLY_ID, body: 'Agreed, will fix', author: { login: 'author' } },
            { body: recordedAnswer('Agreed'), author: { login: BOT_LOGIN } },
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

    it('reads a reply as agreement only when Manki settled it, whatever the reply says', async () => {
      const cases: Array<[string, string[], AuthorReplyClass]> = [
        ['Has this been addressed?', [], 'none'],
        ["I haven't fixed this yet", [], 'none'],
        ['done', [], 'none'],
        ['done', [recordedAnswer('Fixed', 'stays_open')], 'none'],
        ['done', [recordedAnswer('Fixed', 'confirmed_by_round')], 'none'],
        ['done', [recordedAnswer('Fixed').replace('"decision":{"outcome":"Fixed","thread":"resolves"}', '"modelAnswer":{"outcome":"Fixed","proof":[],"cited":["src/b.ts:3"]}')], 'none'],
        ['done', ['**Unverified.** I could not check this reply.\n\n<!-- manki -->'], 'none'],
        ['done', [recordedAnswer('Fixed')], 'agree'],
        ['The caller checks it.', [recordedAnswer('Withdrawn', 'already_resolved')], 'agree'],
        // A later reply waits for its own answer, so an answer to an earlier one counts for nothing, also when it lands
        // after the later reply, as a slow answer does. Only an answer that names the later reply settles it.
        ['Actually, it still breaks.', [recordedAnswer('Fixed'), 'LATER'], 'none'],
        ['Actually, it still breaks.', ['LATER', recordedAnswer('Fixed')], 'none'],
        ['Actually, it still breaks.', ['LATER', recordedAnswer('Fixed', 'resolves', REPLY_ID + 1)], 'agree'],
        // A record that names no reply settles none.
        ['done', [recordedAnswer('Fixed').replace(`,"answers":${REPLY_ID}`, '')], 'none'],
        // So does an answer from before Manki last reopened the thread.
        ['done', [recordedAnswer('Fixed'), `Reopened.\n\n<!-- manki -->\n${REOPENED_MARKER}`], 'none'],
      ];
      for (const [reply, after, expected] of cases) {
        const ctx = makeRoundContext(1, {
          findings: {
            count: 1,
            severityCounts: { warning: 1 },
            entries: [{ fingerprint: { file: 'src/foo.ts', lineStart: 10, lineEnd: 10, slug: 'Null-check' }, severity: 'warning', threadId: 'T1', authorReplyClass: 'none', title: 'Null check' }],
          },
        });
        const comments = after.flatMap(body => body === 'LATER'
          ? [{ databaseId: REPLY_ID + 1, body: reply, author: { login: 'author' } }]
          : [{ body, author: { login: BOT_LOGIN } }]);
        const thread = makeThread({
          id: 'T1',
          comments: { nodes: [
            { body: '<!-- manki:warning:Null-check --> **Warning**: Null check\n\nDescription.', author: { login: BOT_LOGIN } },
            { databaseId: REPLY_ID, body: after.includes('LATER') ? 'Fixed in the last push.' : reply, author: { login: 'author' } },
            ...comments,
          ] },
        });
        const state = await fetchRecapState(mockOctokit([thread], [{ id: 200, body: htmlCommentBlock(ctx), user: { login: BOT_LOGIN } }]), TEST_BOT, 'owner', 'repo', 1, 'author');
        expect([reply, after.length, state.priorRounds[0].findings.entries[0].authorReplyClass]).toEqual([reply, after.length, expected]);
        expect(collectInPrSuppressions(state.previousFindings, 'author').length).toBe(expected === 'agree' ? 1 : 0);
      }
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
            { databaseId: REPLY_ID, body: 'Agreed, will fix', author: { login: 'author' } },
            { body: recordedAnswer('Agreed'), author: { login: BOT_LOGIN } },
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
            { databaseId: REPLY_ID, body: 'Agreed, will fix', author: { login: 'author' } },
            { body: recordedAnswer('Agreed'), author: { login: BOT_LOGIN } },
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

    // Only a thread the PR author alone could not clear is marked as guarded. An unread grade does not make it one.
    const resolved = (threadId: string, overrides: Partial<PreviousFinding>) => makePrevious({ title: 'Missing null check', file: 'src/a.ts', line: 10, status: 'resolved', severity: 'warning', threadId, ...overrides });
    const threads = [
      resolved('plain', {}), resolved('blocker', { severity: 'blocker' }), resolved('security', { isSecurity: true }),
      resolved('raised', { recordedGrade: 'blocker' }), resolved('unknown', { gradeUnknown: true }), resolved('disproved', { disprovedBlocker: true }),
    ];
    expect(collectInPrSuppressions(threads).map(s => s.guarded ?? false)).toEqual([false, true, true, true, false, true]);
    expect([...collectGuardedThreadIds(threads)]).toEqual(['blocker', 'security', 'raised', 'disproved']);
    expect(collectGuardedThreadIds(undefined).size).toBe(0);
  });

  // Note: `fetchReviewThreads` always classifies a thread with at least one
  // non-bot reply as `replied`, so a PreviousFinding with `status: 'open'`
  // and a non-empty `authorReplyText` is not produced today. The `open+...`
  // cases below pin that `inPrSuppressionReasonFor` is status-agnostic for
  // the agree-reply branch (the gate is login + Manki's answer, not status),
  // so the same logic continues to apply if the status taxonomy ever changes.
  // The realistic production cases are covered by the `replied+...` tests.
  it('suppresses open threads whose latest author reply is agree from PR author', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Unused var', file: 'src/a.ts', line: 10, status: 'open', authorReplyText: 'Fixed, thanks!', authorReplyLogin: 'pr-author', replyAgreed: true }),
    ], 'pr-author');
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('agree-reply');
    expect(result[0].authorLogin).toBe('pr-author');
  });

  it('suppresses replied threads whose author reply is agree from PR author', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Null check', file: 'src/a.ts', line: 10, status: 'replied', authorReplyText: 'Fixed, done.', authorReplyLogin: 'pr-author', replyAgreed: true }),
    ], 'pr-author');
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('agree-reply');
    expect(result[0].authorLogin).toBe('pr-author');
  });

  it('does not suppress agree-reply from a third-party commenter (different login than PR author)', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Unused var', file: 'src/a.ts', line: 10, status: 'open', authorReplyText: 'Fixed!', authorReplyLogin: 'random-user', replyAgreed: true }),
    ], 'pr-author');
    expect(result).toHaveLength(0);
  });

  it('does not suppress agree-reply when prAuthorLogin is undefined', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Unused var', file: 'src/a.ts', line: 10, status: 'open', authorReplyText: 'Fixed!', authorReplyLogin: 'pr-author', replyAgreed: true }),
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

  it('does not suppress a thread whose reply Manki did not settle, whatever the reply says', () => {
    const replies = ['Fixed, done.', 'I disagree, this is intentional.', 'Still working on it.'];
    const result = collectInPrSuppressions(replies.flatMap((authorReplyText, i) => (['open', 'replied'] as const).map(status =>
      makePrevious({ title: 'Unused var', file: 'src/a.ts', line: 10 + i, status, authorReplyText, authorReplyLogin: 'pr-author' }))), 'pr-author');
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
      makePrevious({ title: 'Agreed finding', file: 'f.ts', line: 2, status: 'open', authorReplyText: 'addressed in a1b2c3d', authorReplyLogin: 'pr-author', replyAgreed: true }),
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
        content: '[{ "index": 1, "matchedResolved": 1 }]',
      }),
    } as unknown as import('./providers').LLMClient;

    const result = await llmDeduplicateFindings(findings, previous, mockClient);
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0].title).toBe('Unused import');
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].finding.title).toBe('Missing null check');
    expect(result.duplicates[0].matchedTitle).toBe('Null safety issue');
    expect(result.duplicates[0].matchType).toBe('llm');

    // A lockfile alert never reaches the model, so a match it would name can't drop it.
    const alert = makeFinding({ title: 'lockfile-change: updated hey 0.4.3 -> 0.4.2: downgrade.', file: 'Cargo.lock', line: 44 });
    jest.mocked(mockClient.sendMessage).mockClear();
    const withAlert = await llmDeduplicateFindings([alert, ...findings], previous, mockClient);
    expect([withAlert.unique.map(f => f.title), jest.mocked(mockClient.sendMessage).mock.calls[0][1]]).toEqual([[alert.title, 'Unused import'], expect.not.stringContaining('lockfile-change')]);

    const fixed = makePrevious({ ...previous[0], fixed: true });
    const kept = await llmDeduplicateFindings(findings, [fixed], mockClient);
    expect(kept.duplicates).toHaveLength(0);
    expect(kept.unique).toEqual([{ ...findings[0], resemblesFixed: { title: 'Null safety issue', file: 'src/foo.ts', line: 10 } }, findings[1]]);
    jest.mocked(mockClient.sendMessage).mockResolvedValueOnce({ content: '[{ "index": 1, "matchedResolved": 1 }, { "index": 1, "matchedResolved": 2 }]' } as never);
    const both = await llmDeduplicateFindings(findings, [fixed, previous[0]], mockClient);
    expect(both.duplicates.map(d => d.finding.title)).toEqual(['Missing null check']);

    // A blocker or a guarded finding is dropped only for a resolved guarded thread, since the PR author can resolve any other.
    for (const raised of [{ ...findings[0], severity: 'blocker' as const }, ...[SECURITY_TAG, 'disproved-blocker'].map(tag => ({ ...findings[0], severity: 'warning' as const, tags: [tag] }))]) {
      const notWaived = await llmDeduplicateFindings([raised], previous, mockClient);
      expect(notWaived).toEqual({ unique: [raised], duplicates: [] });
      expect(deduplicateFindings([raised], [makePrevious({ ...previous[0], title: raised.title })])).toEqual({ unique: [raised], duplicates: [] });
      for (const guarded of [{ severity: 'blocker' as const }, { isSecurity: true, severity: raised.severity }]) {
        const waived = await llmDeduplicateFindings([raised], [makePrevious({ ...previous[0], ...guarded })], mockClient);
        expect(waived.duplicates.map(d => d.finding.title)).toEqual(['Missing null check']);
        expect(deduplicateFindings([raised], [makePrevious({ ...previous[0], title: raised.title, ...guarded })]).duplicates).toHaveLength(1);
      }
      // A guarded thread graded below the finding, such as a security suggestion, waives nothing above it.
      const below = makePrevious({ ...previous[0], title: raised.title, isSecurity: true, severity: 'note' });
      expect(deduplicateFindings([raised], [below]).unique).toEqual([raised]);
      expect((await llmDeduplicateFindings([raised], [below], mockClient)).unique).toEqual([raised]);
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

  it('catches a reworded repeat of a waived finding from its description and the line it names', async () => {
    // Three wordings of one finding, each posted a round after the one before.
    const memory = { file: 'src/memory.ts', severity: 'warning' as const };
    const waived = makePrevious({
      ...memory, status: 'resolved', threadId: 'T1', line: 0, originalLine: 80, findingLine: 84, answer: 'Agreed. The move is the follow-up.',
      title: 'Repos with `memory.enabled` and no `memory.repo` lose their existing memory silently',
      description: "Before this change, an empty `memory.repo` meant `<owner>/review-memory` (the removed `resolveMemoryRepo`, called with the App's memory token). Now the same config goes to the central store, which starts empty for that repo.",
    });
    const second = makeFinding({
      ...memory, line: 79,
      title: 'Repos on the old default `<owner>/review-memory` quietly lose their stored memory',
      description: 'Before this change, an empty `memory.repo` resolved to `<owner>/review-memory` (the removed `resolveMemoryRepo`). Now an empty `memory.repo` goes straight to the central store.',
    });
    const third = makeFinding({
      ...memory, line: 79,
      title: 'Repos on the old default `<owner>/review-memory` silently lose their memory and start writing to the central repository',
      description: 'Before this change, an empty `memory.repo` resolved to `<owner>/review-memory` through `resolveMemoryRepo`. Now an empty `memory.repo` goes straight to `serviceMemoryStore`, with no warning or log line.',
    });
    const match = { sendMessage: jest.fn().mockResolvedValue({ content: '[{ "index": 1, "matchedResolved": 1 }]' }) } as unknown as import('./providers').LLMClient;

    // The titles share too few words for the static match, so the model compares the descriptions on the line the
    // finding names, not the line its outdated thread was posted on.
    expect(deduplicateFindings([second], [waived]).unique).toEqual([second]);
    expect(await llmDeduplicateFindings([second], [waived], match)).toEqual({ unique: [], duplicates: [{ finding: second, matchedTitle: waived.title, matchType: 'llm' }] });
    const [, prompt] = jest.mocked(match.sendMessage).mock.calls[0];
    expect(prompt).toContain('(src/memory.ts:84): "Before this change, an empty memory.repo meant');
    expect(prompt).toContain('(src/memory.ts:79): "Before this change, an empty memory.repo resolved to');
    // A finding or a thread that names no line is listed by its file alone.
    const wholeFile = { ...waived, findingLine: undefined, originalLine: undefined };
    await llmDeduplicateFindings([{ ...second, line: 0 }], [wholeFile], match);
    const fileOnly = jest.mocked(match.sendMessage).mock.calls.at(-1)![1];
    expect(fileOnly).not.toContain('src/memory.ts:');
    expect(fileOnly.match(/\(src\/memory\.ts\): "/g)).toHaveLength(2);

    // The next wording shares words with the title of the one before but is no certain match, so only the model sends
    // it to the judge with the answer in that thread, which is still open and waives nothing.
    const answered = makePrevious({ ...memory, status: 'replied', threadId: 'T2', line: 79, title: second.title, answer: 'Unverified. The move is not in this PR.' });
    expect(deduplicateFindings([third], [answered]).unique).toEqual([third]);
    expect(await llmDeduplicateFindings([third], [answered], match)).toEqual({ unique: [{ ...third, answeredIn: { threadId: 'T2', answer: 'Unverified. The move is not in this PR.', grade: { severity: answered.severity } } }], duplicates: [] });

    // The same problem in another file is another place, so a model match there changes nothing.
    const elsewhere = { ...second, file: 'src/index.ts' };
    expect(await llmDeduplicateFindings([elsewhere], [waived], match)).toEqual({ unique: [elsewhere], duplicates: [] });
    // Unless the round pairs the two, as by a line both cite, and no push since may have changed the code. A match in
    // another file can be a fix that came back there, so after a change, or with the push unknown, it goes to the judge
    // on its own, to be posted at its own place.
    const paired = (prev: PreviousFinding, f: Finding) => prev.title === waived.title && f.file === elsewhere.file;
    const dropped = (finding: Finding) => ({ unique: [], duplicates: [{ finding, matchedTitle: waived.title, matchType: 'llm' }] });
    expect(await llmDeduplicateFindings([elsewhere], [waived], match, paired, () => false)).toEqual(dropped(elsewhere));
    expect(await llmDeduplicateFindings([elsewhere], [waived], match, paired, () => true)).toEqual({ unique: [elsewhere], duplicates: [] });
    expect(await llmDeduplicateFindings([elsewhere], [waived], match, paired)).toEqual({ unique: [elsewhere], duplicates: [] });
    // In its own file a thread a person resolved drops the repeat whatever a push changed, as in static dedup.
    expect(await llmDeduplicateFindings([second], [waived], match, paired, () => true)).toEqual(dropped(second));
    // A thread Manki resolved after an answer that accepted no fix was decided too, but only for the code its answer
    // read. After a push that may have changed it, a repeat in its own file goes to the judge with the answer, as static
    // dedup sends one, and a repeat in another file goes on its own. One whose answers do not show a decision may have
    // been fixed, so it drops nothing, and a repeat in its own file goes to the judge with the answer.
    const settledByReply = { ...waived, status: 'auto-resolved' as const };
    const decided = { ...settledByReply, decidedWithoutFix: true };
    const answeredIn = { threadId: 'T1', answer: waived.answer, grade: { severity: waived.severity } };
    for (const [finding, rechecked] of [[second, { ...second, answeredIn }], [elsewhere, elsewhere]] as const) {
      expect(await llmDeduplicateFindings([finding], [decided], match, paired, () => false)).toEqual(dropped(finding));
      expect(await llmDeduplicateFindings([finding], [decided], match, paired, () => true)).toEqual({ unique: [rechecked], duplicates: [] });
      expect(await llmDeduplicateFindings([finding], [decided], match, paired)).toEqual({ unique: [rechecked], duplicates: [] });
      expect(await llmDeduplicateFindings([finding], [settledByReply], match, paired, () => false)).toEqual({ unique: [rechecked], duplicates: [] });
    }

    // A resolved or answered suggestion is graded below a warning, so it neither waives the warning nor answers it.
    const suggestion = { ...waived, severity: 'note' as const };
    expect(await llmDeduplicateFindings([second], [suggestion], match)).toEqual({ unique: [second], duplicates: [] });
    expect((await llmDeduplicateFindings([third], [{ ...answered, severity: 'note' }], match)).unique).toEqual([third]);
    expect((await llmDeduplicateFindings([{ ...third, severity: 'note' }], [{ ...answered, severity: 'note' }], match)).unique[0].answeredIn?.threadId).toBe('T2');
  });

  it('does not treat replied findings as dismissed', async () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 10 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', status: 'replied', threadId: 'T1', answer: 'Kept. `id` can be null here.' })];
    const mockClient = { sendMessage: jest.fn().mockResolvedValue({ content: '[{ "index": 1, "matchedResolved": 1 }]' }) } as unknown as import('./providers').LLMClient;

    // A repeat of a thread still open goes to the judge with the answer there, and is never dropped.
    const result = await llmDeduplicateFindings(findings, previous, mockClient);
    expect(result).toEqual({ unique: [{ ...findings[0], answeredIn: { threadId: 'T1', answer: 'Kept. `id` can be null here.', grade: { severity: previous[0].severity } } }], duplicates: [] });
    // A replied thread without an answer gives the model nothing to compare.
    const unanswered = [{ ...previous[0], answer: undefined }];
    expect(await llmDeduplicateFindings(findings, unanswered, mockClient)).toEqual({ unique: findings, duplicates: [] });
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
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
        content: '```json\n[{ "index": 1, "matchedResolved": 1 }]\n```',
      }),
    } as unknown as import('./providers').LLMClient;

    const result = await llmDeduplicateFindings(findings, previous, mockClient);
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0].title).toBe('Unused import');
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].finding.title).toBe('Missing null check');
    expect(result.duplicates[0].matchedTitle).toBe('Null safety issue');
  });

  it('keeps finding in unique when matchedResolved index is out of bounds', async () => {
    const findings = [
      makeFinding({ title: 'Null check missing', file: 'src/foo.ts', line: 10 }),
    ];
    const previous = [
      makePrevious({ title: 'Old issue A', file: 'src/a.ts', line: 1, status: 'resolved' }),
      makePrevious({ title: 'Old issue B', file: 'src/b.ts', line: 2, status: 'resolved' }),
    ];
    const mockClient = {
      sendMessage: jest.fn().mockResolvedValue({
        content: '[{ "index": 1, "matchedResolved": 99 }]',
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
  it('extracts the description of a not-blocking or unconfirmed comment from `formatFindingComment`', () => {
    const body = formatFindingComment({ severity: 'note', title: 'Extract helper', file: 'src/a.ts', line: 2, description: 'The logic is duplicated.', reviewers: [] }, TEST_LINKS);
    expect(parseFindingFromComment(body)).toEqual({ description: 'The logic is duplicated.', suggestedFix: undefined });
    const unconfirmed = formatFindingComment({ severity: 'warning', title: 'Extract helper', file: 'src/a.ts', line: 2, description: 'The logic is duplicated.', reviewers: [], checkStatus: 'unconfirmed' }, TEST_LINKS);
    expect(unconfirmed).toContain('_Manki could not confirm this, since no line in the code was cited for it._');
    expect(parseFindingFromComment(unconfirmed)).toEqual({ description: 'The logic is duplicated.', suggestedFix: undefined });
    // The sentence on a warning an earlier round missed is not part of the description either, alone or after the other one.
    for (const checkStatus of [undefined, 'unconfirmed' as const]) {
      const late = formatFindingComment({ severity: 'warning', title: 'Extract helper', file: 'src/a.ts', line: 2, description: 'The logic is duplicated.', reviewers: [], origin: 'reviewed', tags: ['follow-up'], checkStatus }, TEST_LINKS);
      expect(late).toContain('_An earlier round already reviewed these lines and missed this. It is in this PR\'s own code, so it still holds the approval._');
      expect(parseFindingFromComment(late)).toEqual({ description: 'The logic is duplicated.', suggestedFix: undefined });
      // A thread posted while warnings did not hold reads the same with its old header and note.
      expect(late).toMatch(/^\u26A0\uFE0F \*\*Warning\*\*\n/u);
      const old = late.replace('**Warning**', '**Warning, not blocking**')
        .replace('_An earlier round already reviewed these lines and missed this. It is in this PR\'s own code, so it still holds the approval._', '_An earlier round already reviewed these lines and missed this, and it doesn\'t block this PR._');
      expect(old).toContain('**Warning, not blocking**\n\n**Extract helper**\n\n');
      expect(parseFindingFromComment(old)).toEqual({ description: 'The logic is duplicated.', suggestedFix: undefined });
      expect(threadSeverity(old)).toBe('warning');
      // So do threads posted while warnings held, with the label and the note of an earlier wording.
      const earlier = late.replace('**Warning**', '**Warning, needs an answer**').replace('so it still holds the approval._', 'so it still needs a fix or an answer._');
      expect(earlier).toContain('**Warning, needs an answer**\n\n**Extract helper**\n\n');
      expect(parseFindingFromComment(earlier)).toEqual({ description: 'The logic is duplicated.', suggestedFix: undefined });
      // A security warning has its own header and note, which are not part of the description either.
      const security = formatFindingComment({ severity: 'warning', title: 'Token in log', file: 'src/a.ts', line: 2, description: 'The token is logged.', reviewers: [], origin: 'reviewed', tags: ['follow-up', 'security'], checkStatus }, TEST_LINKS);
      expect(security).toMatch(/^⚠️ \*\*Warning, needs a fix\*\*\n/u);
      expect(parseFindingFromComment(security)).toEqual({ description: 'The token is logged.', suggestedFix: undefined });
      // Nor is the sentence on a warning that restates one an earlier review body listed.
      for (const tags of [['follow-up'], ['follow-up', 'security']]) {
        const listed = formatFindingComment({ severity: 'warning', title: 'Token in log', file: 'src/a.ts', line: 2, description: 'The token is logged.', reviewers: [], origin: 'earlier', raisedIn: 1, tags, checkStatus }, TEST_LINKS);
        expect(listed).toContain(tags.includes('security')
          ? '_An earlier round already listed this in its review body. It still needs a fix or a maintainer to resolve it._'
          : '_An earlier round already listed this in its review body. It still holds the approval._');
        expect(parseFindingFromComment(listed)).toEqual({ description: 'The token is logged.', suggestedFix: undefined });
      }
    }
    // The issue box, and the link that replaces it once ticked, are not part of the description.
    expect(body).toContain('Create an issue for this');
    const filed = body.replace(/- \[ \] Create an issue for this[^\n]*/, 'Issue #12 created by `@bob`');
    expect(parseFindingFromComment(filed)).toEqual({ description: 'The logic is duplicated.', suggestedFix: undefined });
    const toolBody = formatFindingComment({ severity: 'warning', title: 'js/sql-injection: Query built from user input', file: 'src/a.ts', line: 2, description: 'The query uses `name`.', reviewers: ['CodeQL'], toolSource: 'CodeQL (1.2)', category: 'security', effort: 'quick' }, TEST_LINKS);
    // The plain label with a tool name is read as a header above the title, never as a one-line title.
    expect(toolBody.split('\n')[0]).toBe('\u26A0\uFE0F **Warning** (CodeQL (1.2)) · Security · Quick fix');
    expect(parseFindingFromComment(toolBody)).toEqual({ description: 'The query uses `name`.', suggestedFix: undefined });
    // A tool name cannot pass as the end of a title line, and a line of the description cannot pass as the fix label.
    const oddTool = formatFindingComment({ severity: 'warning', title: 'Query built from user input', file: 'src/a.ts', line: 2, description: 'The query uses `name`.', reviewers: ['CodeQL'], toolSource: 'CodeQL (1.2):: beta' }, TEST_LINKS);
    expect(oddTool.split('\n')[0]).toContain('(CodeQL (1.2) beta)');
    expect(parseFindingFromComment(oddTool)).toEqual({ description: 'The query uses `name`.', suggestedFix: undefined });
    const fixLine = formatFindingComment({ severity: 'note', title: 'Extract helper', file: 'src/a.ts', line: 2, description: 'The logic is duplicated.\n**Fix:** move it.', reviewers: [], howToFix: 'Move it to a helper.' }, TEST_LINKS);
    expect(fixLine).toContain('\n**Fix:** Move it to a helper.');
    expect(parseFindingFromComment(fixLine)).toEqual({ description: 'The logic is duplicated.\n**Fix**: move it.', suggestedFix: undefined, howToFix: 'Move it to a helper.' });
    // A thread posted on another file opens with a note on where the finding is, which is no part of the description.
    // The note is read by its place, so it is skipped whatever the highlighting of the diff's identifiers makes of it.
    const identifiers = new Set(['This', 'Comments', 'thread', 'posted', 'here', 'src/store.ts', '_store_file_', 'src/_store_file_.ts']);
    // A file name is finder text in that note, so one that reads like a label of Manki's layout is still only part of the note.
    for (const file of ['src/store.ts', 'src/_store_file_.ts', 'src/a*b*.ts', 'src/**Warning**: x.ts', 'src/**Blocker** y.ts', 'src/**What goes wrong:** z.ts', '']) {
      // With no other note under it, the line below the note is the description itself.
      for (const checkStatus of [undefined, 'unconfirmed' as const]) {
        const detached = formatFindingComment({ severity: 'blocker', title: 'Extract helper', file, line: 2, description: 'The logic is duplicated.', reviewers: [], checkStatus }, TEST_LINKS, 'detached');
        expect(detached).toContain(`so the thread is posted here.\n\n${checkStatus ? '_Manki could not confirm this' : '**What goes wrong:** The logic is duplicated.'}`);
        for (const posted of [detached, highlightCode(detached, identifiers)]) {
          expect(parseFindingFromComment(posted)).toEqual({ description: 'The logic is duplicated.', suggestedFix: undefined });
        }
      }
    }
    // A late warning on such a thread has all three notes under its title. The first is the one on where the finding is, and the other two are skipped in either order.
    const late = formatFindingComment({ severity: 'warning', title: 'Extract helper', file: 'src/store.ts', line: 2, description: 'The logic is duplicated.', reviewers: [], tags: ['follow-up'], checkStatus: 'unconfirmed', origin: 'reviewed' }, TEST_LINKS, 'detached');
    const notes = late.match(/(This is in [^\n]+)\n\n(_Manki could not confirm[^\n]+)\n\n(_An earlier round already reviewed[^\n]+)\n\n/);
    expect(notes).not.toBeNull();
    for (const order of [[1, 2, 3], [1, 3, 2]]) {
      const body = late.replace(notes![0], `${order.map(i => notes![i]).join('\n\n')}\n\n`);
      expect(parseFindingFromComment(body)).toEqual({ description: 'The logic is duplicated.', suggestedFix: undefined });
    }
    // A thread on the finding's file opens with a link to the finding's line, which is no part of the description either.
    // The description is the one the same thread gives without that line, as a thread posted before the line existed has it.
    const long = 'The logic is duplicated. '.repeat(40).trim();
    for (const description of ['The logic is duplicated.', long]) {
      const onFile = formatFindingComment({ severity: 'blocker', title: 'Extract helper', file: 'src/a.ts', line: 2, description, reviewers: [] }, TEST_LINKS, 'file');
      const lineNote = 'This is on [line 2](https://github.com/o/r/blob/sha/src/a.ts#L2). A comment on that line is not possible, so the thread is elsewhere in the file.\n\n';
      expect(onFile).toContain(`**Extract helper**\n\n${lineNote}**What goes wrong:** The logic is duplicated.`);
      const before = onFile.replace(lineNote, '').replace(',"lineNote":true', '');
      // A finding that names no line says it concerns the whole file, which is no part of the description either.
      const wholeFile = formatFindingComment({ severity: 'blocker', title: 'Extract helper', file: 'src/a.ts', line: 0, description, reviewers: [] }, TEST_LINKS, 'file');
      expect(wholeFile).toContain('**Extract helper**\n\nThis concerns the whole file, not one line of it.\n\n**What goes wrong:**');
      expect(parseFindingFromComment(wholeFile)).toEqual(parseFindingFromComment(before));
      expect(before).toBe(wholeFile.replace('This concerns the whole file, not one line of it.\n\n', '').replace(',"lineNote":true', '').replace('src/a.ts:0:', 'src/a.ts:2:').replace('"line":0', '"line":2'));
      const parsed = parseFindingFromComment(before);
      expect(parsed.description).toMatch(/^The logic is duplicated\./);
      for (const posted of [onFile, highlightCode(onFile, new Set(['This', 'comment', 'thread', 'file', 'line']))]) {
        expect(parseFindingFromComment(posted)).toEqual(parsed);
      }
    }
    // Without the word of the finding data, such a sentence is the description.
    const lineSentence = 'This is on line 2. A comment on that line is not possible, so the thread is elsewhere in the file.';
    expect(parseFindingFromComment(formatFindingComment({ severity: 'note', title: 'Extract helper', file: 'src/a.ts', line: 0, description: lineSentence, reviewers: [] }, TEST_LINKS, 'file')).description).toBe(lineSentence);
    // When the title line is not at the top, the layout is not Manki's own, and no line is dropped on the word of the finding data.
    const edited = `Edited by hand.\n\n${formatFindingComment({ severity: 'blocker', title: 'Extract helper', file: 'src/**Warning**: x.ts', line: 2, description: 'The logic is duplicated.', reviewers: [] }, TEST_LINKS, 'detached')}`;
    expect(parseFindingFromComment(edited).description).toBe('The logic is duplicated.');
    // The title is the line under the header, so a label in the description is part of the description.
    const labelled = 'It reads **Warning**: not a title, and then goes on.';
    expect(parseFindingFromComment(formatFindingComment({ severity: 'warning', title: 'Extract helper', file: 'src/a.ts', line: 2, description: labelled, reviewers: [] }, TEST_LINKS)).description).toBe(labelled);
    // The first line is skipped only on a thread whose finding data says it is posted elsewhere.
    const sentence = 'This is not tied to a file or line. Comments are only possible on changed files, so the thread is posted here.';
    const quoted = formatFindingComment({ severity: 'note', title: 'Extract helper', file: 'src/a.ts', line: 2, description: sentence, reviewers: [] }, TEST_LINKS);
    expect(parseFindingFromComment(quoted).description).toBe(sentence);
    // The scope reader's threads tied to no file open with their description, so no line is skipped there.
    for (const [title, description] of [[SCOPE_DOUBT_TITLE, 'Nothing calls `parseDate`.'], [SCOPE_SPLIT_TITLE, 'Suggestion about the PR as a whole.']]) {
      const scopeThread = formatFindingComment({ severity: 'warning', title, file: '', line: 0, description, reviewers: [SCOPE_READER_NAME] }, TEST_LINKS, 'detached');
      expect(parseFindingFromComment(scopeThread).description).toBe(description);
      expect(findingPlace(scopeThread, 'src/a.ts', 1)).toEqual({ file: '', line: 0 });
    }
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
    const body = makeCommentBody('Desc.', '{"fix":"Add null check before access","severity":"note","confidence":"high","flaggedBy":["Correctness"]}');
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
    const body = makeCommentBody('Desc.', '{"severity":"note","confidence":"high","flaggedBy":["Correctness"]}');
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
    const body = makeCommentBody('Desc.', `{"fix":"${longFix}","severity":"note"}`);
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
      findings: { count: entries.length, severityCounts: { blocker: 0, warning: 0, note: 0 }, entries },
      usage: {},
      verdict: 'COMMENT',
    };
  }

  function makeEntry(overrides: Partial<FindingFingerprintEntry> = {}): FindingFingerprintEntry {
    return {
      fingerprint: { file: 'src/foo.ts', slug: 'test-finding', lineStart: 10, lineEnd: 10 },
      severity: 'note',
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
      { title: 'Test finding', file: 'src/foo.ts', line: 10, severity: 'note', status: 'resolved', threadId: 'T1', authorReplyText: 'LGTM fixed', replyAgreed: true },
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
      { title: 'Test finding', file: 'src/foo.ts', line: 10, severity: 'note', status: 'resolved', authorReplyText: 'fixed', replyAgreed: true },
    ];

    const result = refreshAuthorReplyClass(rounds, previousFindings);
    expect(result.reclassifiedPriorCount).toBe(1);
    expect(result.reclassifiedPriors).toHaveLength(0);
  });

  it('records every flip', () => {
    const entries = Array.from({ length: 55 }, (_, i) => makeEntry({ threadId: `T${i}`, authorReplyClass: 'none' }));
    const previousFindings: PreviousFinding[] = entries.map((e, i) => ({
      title: 'Test finding', file: 'src/foo.ts', line: 10, severity: 'note' as const, status: 'resolved' as const, threadId: `T${i}`, authorReplyText: 'fixed', replyAgreed: true,
    }));

    const result = refreshAuthorReplyClass([makeRound(entries)], previousFindings);
    expect(result.reclassifiedPriorCount).toBe(55);
    expect(result.reclassifiedPriors).toHaveLength(55);
  });
});
