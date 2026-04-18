import { Finding } from './types';
import { Suppression } from './memory';
import { classifyAuthorReply, collectInPrSuppressions, deduplicateFindings, fingerprintFinding, PreviousFinding, fetchRecapState, titlesOverlap, llmDeduplicateFindings } from './recap';
import { titleToSlug } from './github';

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

const makeSuppression = (overrides: Partial<Suppression> = {}): Suppression => ({
  id: 'sup-1',
  pattern: 'test finding',
  reason: 'intentional',
  created_by: 'user',
  created_at: '2025-01-01',
  pr_ref: 'owner/repo#1',
  ...overrides,
});

describe('deduplicateFindings', () => {
  it('detects exact match by title, file, and line', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42, status: 'resolved' })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
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

describe('deduplicateFindings with suppressions', () => {
  it('filters findings matching a suppression', () => {
    const findings = [makeFinding({ title: 'Test finding in module', file: 'src/foo.ts', line: 10 })];
    const suppressions = [makeSuppression({ pattern: 'test finding' })];

    const result = deduplicateFindings(findings, [], suppressions);
    expect(result.unique).toHaveLength(0);
  });

  it('keeps findings that do not match any suppression', () => {
    const findings = [makeFinding({ title: 'Unused variable', file: 'src/foo.ts', line: 10 })];
    const suppressions = [makeSuppression({ pattern: 'test finding' })];

    const result = deduplicateFindings(findings, [], suppressions);
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0].title).toBe('Unused variable');
  });

  it('works with no suppressions (backward compat)', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];

    const result = deduplicateFindings(findings, []);
    expect(result.unique).toHaveLength(1);
  });

  it('works with undefined suppressions (backward compat)', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];

    const result = deduplicateFindings(findings, [], undefined);
    expect(result.unique).toHaveLength(1);
  });

  it('works with empty suppressions array', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];

    const result = deduplicateFindings(findings, [], []);
    expect(result.unique).toHaveLength(1);
  });

  it('respects file_glob in suppressions', () => {
    const findings = [
      makeFinding({ title: 'Test finding A', file: 'src/foo.ts', line: 10 }),
      makeFinding({ title: 'Test finding B', file: 'test/bar.ts', line: 20 }),
    ];
    const suppressions = [makeSuppression({ pattern: 'test finding', file_glob: 'src/**' })];

    const result = deduplicateFindings(findings, [], suppressions);
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0].title).toBe('Test finding B');
  });

  it('applies both suppressions and dedup together', () => {
    const findings = [
      makeFinding({ title: 'Test finding', file: 'src/foo.ts', line: 10 }),
      makeFinding({ title: 'Missing null check', file: 'src/bar.ts', line: 42 }),
      makeFinding({ title: 'Unused import', file: 'src/baz.ts', line: 5 }),
    ];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/bar.ts', line: 42, status: 'resolved' })];
    const suppressions = [makeSuppression({ pattern: 'test finding' })];

    const result = deduplicateFindings(findings, previous, suppressions);
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0].title).toBe('Unused import');
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].finding.title).toBe('Missing null check');
    expect(result.duplicates[0].matchedTitle).toBe('Missing null check');
  });
});

describe('fetchRecapState', () => {
  function makeThread(overrides: Record<string, unknown> = {}) {
    return {
      id: 'thread-1',
      isResolved: false,
      path: 'src/foo.ts',
      line: 10,
      comments: {
        nodes: [{
          body: '<!-- manki:blocker:Null-check --> \u{1F6AB} **Blocker**: Missing null check\n\nDescription here.',
          author: { login: 'github-actions[bot]' },
        }],
      },
      ...overrides,
    };
  }

  function mockOctokit(threads: ReturnType<typeof makeThread>[]) {
    return {
      graphql: jest.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: threads,
            },
          },
        },
      }),
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
            author: { login: 'github-actions[bot]' },
          }],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, 'owner', 'repo', 1);
    expect(state.previousFindings).toHaveLength(2);
    expect(state.previousFindings[0].status).toBe('resolved');
    expect(state.previousFindings[1].status).toBe('open');
    expect(state.recapContext).toContain('Previous Review State');
    expect(state.recapContext).toContain('Resolved (1 findings');
    expect(state.recapContext).toContain('Still Open (1 findings');
  });

  it('returns empty state when no bot threads exist', async () => {
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
    ]);

    const state = await fetchRecapState(octokit, 'owner', 'repo', 1);
    expect(state.previousFindings).toHaveLength(0);
    expect(state.recapContext).toBe('');
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
              author: { login: 'github-actions[bot]' },
            },
            {
              body: 'I disagree with this finding.',
              author: { login: 'developer' },
            },
          ],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, 'owner', 'repo', 1);
    expect(state.previousFindings).toHaveLength(1);
    expect(state.previousFindings[0].status).toBe('replied');
  });

  it('handles graphql errors gracefully', async () => {
    const octokit = {
      graphql: jest.fn().mockRejectedValue(new Error('GraphQL error')),
    } as unknown as ReturnType<typeof import('@actions/github').getOctokit>;

    const state = await fetchRecapState(octokit, 'owner', 'repo', 1);
    expect(state.previousFindings).toHaveLength(0);
    expect(state.recapContext).toBe('');
  });

  it('extracts severity from bot marker', async () => {
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        isResolved: false,
        comments: {
          nodes: [{
            body: '<!-- manki:nitpick:Style-issue --> \u{1F4DD} **Nitpick**: Style issue\n\nMinor.',
            author: { login: 'github-actions[bot]' },
          }],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, 'owner', 'repo', 1);
    expect(state.previousFindings[0].severity).toBe('nitpick');
  });

  it('returns unknown severity when marker is missing', async () => {
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        comments: {
          nodes: [{
            body: '<!-- manki --> Some finding without severity marker',
            author: { login: 'github-actions[bot]' },
          }],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, 'owner', 'repo', 1);
    expect(state.previousFindings[0].severity).toBe('unknown');
  });

  it('migrates legacy severity markers (`required`, `nit`) on read', async () => {
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        comments: {
          nodes: [{
            body: '<!-- manki:required:Old-blocker --> **Required**: legacy blocker',
            author: { login: 'github-actions[bot]' },
          }],
        },
      }),
      makeThread({
        id: 't2',
        comments: {
          nodes: [{
            body: '<!-- manki:nit:Old-nit --> **Nit**: legacy nitpick',
            author: { login: 'github-actions[bot]' },
          }],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, 'owner', 'repo', 1);
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
            author: { login: 'github-actions[bot]' },
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
            author: { login: 'github-actions[bot]' },
          }],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, 'owner', 'repo', 1);
    expect(state.previousFindings[0].title).toBe('Prompt injection via unsanitized file paths');
    expect(state.previousFindings[1].title).toBe('LLM dedup only compares against resolved findings');
  });

  it('handles null line in thread', async () => {
    const octokit = mockOctokit([
      makeThread({ id: 't1', line: null }),
    ]);

    const state = await fetchRecapState(octokit, 'owner', 'repo', 1);
    expect(state.previousFindings[0].line).toBe(0);
  });

  it('treats first non-bot comment body as author reply text', async () => {
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        isResolved: false,
        comments: {
          nodes: [
            {
              body: '<!-- manki:blocker:Bug --> \u{1F6AB} **Blocker**: Bug found\n\nDesc.',
              author: { login: 'github-actions[bot]' },
            },
            {
              body: 'Fixed, done.',
              author: { login: 'developer' },
            },
          ],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, 'owner', 'repo', 1);
    expect(state.previousFindings[0].authorReplyText).toBe('Fixed, done.');
  });

  it('leaves authorReplyText undefined for threads with only bot comments', async () => {
    const octokit = mockOctokit([
      makeThread({ id: 't1' }),
    ]);

    const state = await fetchRecapState(octokit, 'owner', 'repo', 1);
    expect(state.previousFindings[0].authorReplyText).toBeUndefined();
  });

  it('populates lineStart from startLine when present for multi-line annotations', async () => {
    const octokit = mockOctokit([
      makeThread({ id: 't1', line: 44, startLine: 40 }),
    ]);

    const state = await fetchRecapState(octokit, 'owner', 'repo', 1);
    expect(state.previousFindings[0].line).toBe(44);
    expect(state.previousFindings[0].lineStart).toBe(40);
  });

  it('falls back lineStart to line when startLine is null', async () => {
    const octokit = mockOctokit([
      makeThread({ id: 't1', line: 42, startLine: null }),
    ]);

    const state = await fetchRecapState(octokit, 'owner', 'repo', 1);
    expect(state.previousFindings[0].lineStart).toBe(42);
  });

  it('builds recap context with only resolved findings', async () => {
    const octokit = mockOctokit([
      makeThread({ id: 't1', isResolved: true }),
    ]);

    const state = await fetchRecapState(octokit, 'owner', 'repo', 1);
    expect(state.recapContext).toContain('Resolved (1 findings');
    expect(state.recapContext).not.toContain('Still Open');
  });

  it('builds recap context with only open findings', async () => {
    const octokit = mockOctokit([
      makeThread({ id: 't1', isResolved: false }),
    ]);

    const state = await fetchRecapState(octokit, 'owner', 'repo', 1);
    expect(state.recapContext).not.toContain('Resolved');
    expect(state.recapContext).toContain('Still Open (1 findings');
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
  });

  it('suppresses open threads whose latest author reply is agree', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Unused var', file: 'src/a.ts', line: 10, status: 'open', authorReplyText: 'Fixed, thanks!' }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('agree-reply');
  });

  it('suppresses replied threads whose author reply is agree', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Null check', file: 'src/a.ts', line: 10, status: 'replied', authorReplyText: 'Fixed, done.' }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('agree-reply');
  });

  it('does not suppress open threads whose author reply is disagree', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Unused var', file: 'src/a.ts', line: 10, status: 'open', authorReplyText: 'I disagree, this is intentional.' }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('does not suppress replied threads whose author reply is partial', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Unused var', file: 'src/a.ts', line: 10, status: 'replied', authorReplyText: 'Still working on it.' }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('does not suppress open threads whose author reply is partial', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Unused var', file: 'src/a.ts', line: 10, status: 'open', authorReplyText: 'Working on it.' }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('does not suppress open threads with no author reply', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Unused var', file: 'src/a.ts', line: 10, status: 'open' }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('does not suppress replied threads with no author reply', () => {
    const result = collectInPrSuppressions([
      makePrevious({ title: 'Some issue', file: 'src/a.ts', line: 10, status: 'replied' }),
    ]);
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
      makePrevious({ title: 'Agreed finding', file: 'f.ts', line: 2, status: 'open', authorReplyText: 'addressed in a1b2c3d' }),
      makePrevious({ title: 'Kept finding', file: 'f.ts', line: 3, status: 'open', authorReplyText: "no, keeping it" }),
    ]);
    expect(result.map(r => r.reason)).toEqual(['resolved-thread', 'agree-reply']);
  });
});

describe('llmDeduplicateFindings', () => {
  it('returns all findings when no dismissed findings exist', async () => {
    const findings = [makeFinding({ title: 'Null check missing', file: 'src/foo.ts', line: 10 })];
    const previous = [makePrevious({ status: 'open' })];
    const mockClient = { sendMessage: jest.fn() } as unknown as import('./claude').ClaudeClient;

    const result = await llmDeduplicateFindings(findings, previous, mockClient);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it('returns all findings when no findings to check', async () => {
    const previous = [makePrevious({ status: 'resolved' })];
    const mockClient = { sendMessage: jest.fn() } as unknown as import('./claude').ClaudeClient;

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
    } as unknown as import('./claude').ClaudeClient;

    const result = await llmDeduplicateFindings(findings, previous, mockClient);
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0].title).toBe('Unused import');
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].finding.title).toBe('Missing null check');
    expect(result.duplicates[0].matchedTitle).toBe('Null safety issue');
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
    } as unknown as import('./claude').ClaudeClient;

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
    } as unknown as import('./claude').ClaudeClient;

    const result = await llmDeduplicateFindings(findings, previous, mockClient);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });

  it('does not treat replied findings as dismissed', async () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 10 })];
    const previous = [makePrevious({ title: 'Missing null check', status: 'replied' })];
    const mockClient = { sendMessage: jest.fn() } as unknown as import('./claude').ClaudeClient;

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
    } as unknown as import('./claude').ClaudeClient;

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
    } as unknown as import('./claude').ClaudeClient;

    const result = await llmDeduplicateFindings(findings, previous, mockClient);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });
});
