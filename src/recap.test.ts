import { Finding } from './types';
import { Suppression } from './memory';
import { deduplicateFindings, buildRecapSummary, PreviousFinding, resolveAddressedThreads, fetchRecapState, titlesOverlap, llmDeduplicateFindings } from './recap';

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

describe('resolveAddressedThreads', () => {
  it('is exported as a function', () => {
    expect(typeof resolveAddressedThreads).toBe('function');
  });

  it('returns 0 when no client is provided and candidates exist', async () => {
    const mockOctokit = {} as ReturnType<typeof import('@actions/github').getOctokit>;
    const findings = [makePrevious({
      title: 'Missing null check',
      file: 'src/foo.ts',
      line: 10,
      status: 'open',
      threadId: 'thread-1',
    })];
    const diff = {
      files: [{
        path: 'src/foo.ts',
        changeType: 'modified' as const,
        hunks: [{ oldStart: 8, oldLines: 5, newStart: 8, newLines: 5, content: 'if (x != null) {}' }],
      }],
      totalAdditions: 1,
      totalDeletions: 1,
    };

    const result = await resolveAddressedThreads(mockOctokit, null, 'owner', 'repo', 1, findings, diff);
    expect(result).toBe(0);
  });

  it('returns 0 when no open findings match any hunks', async () => {
    const mockOctokit = {} as ReturnType<typeof import('@actions/github').getOctokit>;
    const findings = [makePrevious({
      title: 'Missing null check',
      file: 'src/foo.ts',
      line: 100,
      status: 'open',
      threadId: 'thread-1',
    })];
    const diff = {
      files: [{
        path: 'src/foo.ts',
        changeType: 'modified' as const,
        hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, content: 'some code' }],
      }],
      totalAdditions: 1,
      totalDeletions: 1,
    };

    const result = await resolveAddressedThreads(mockOctokit, null, 'owner', 'repo', 1, findings, diff);
    expect(result).toBe(0);
  });

  it('resolves threads when Claude confirms findings are addressed', async () => {
    const graphqlMock = jest.fn().mockResolvedValue({ thread: { isResolved: true } });
    const mockOctokit = { graphql: graphqlMock } as unknown as ReturnType<typeof import('@actions/github').getOctokit>;
    const mockClient = {
      sendMessage: jest.fn().mockResolvedValue({
        content: '[{ "index": 0, "addressed": true, "reason": "null check added" }]',
      }),
    } as unknown as import('./claude').ClaudeClient;

    const findings = [makePrevious({
      title: 'Missing null check',
      file: 'src/foo.ts',
      line: 10,
      status: 'open',
      threadId: 'thread-1',
    })];
    const diff = {
      files: [{
        path: 'src/foo.ts',
        changeType: 'modified' as const,
        hunks: [{ oldStart: 8, oldLines: 5, newStart: 8, newLines: 5, content: 'if (x != null) {}' }],
      }],
      totalAdditions: 1,
      totalDeletions: 1,
    };

    const result = await resolveAddressedThreads(mockOctokit, mockClient, 'owner', 'repo', 1, findings, diff);
    expect(result).toBe(1);
    expect(graphqlMock).toHaveBeenCalledTimes(1);
  });

  it('does not resolve threads when Claude says finding is not addressed', async () => {
    const graphqlMock = jest.fn();
    const mockOctokit = { graphql: graphqlMock } as unknown as ReturnType<typeof import('@actions/github').getOctokit>;
    const mockClient = {
      sendMessage: jest.fn().mockResolvedValue({
        content: '[{ "index": 0, "addressed": false, "reason": "only whitespace change" }]',
      }),
    } as unknown as import('./claude').ClaudeClient;

    const findings = [makePrevious({
      title: 'Missing null check',
      file: 'src/foo.ts',
      line: 10,
      status: 'open',
      threadId: 'thread-1',
    })];
    const diff = {
      files: [{
        path: 'src/foo.ts',
        changeType: 'modified' as const,
        hunks: [{ oldStart: 8, oldLines: 5, newStart: 8, newLines: 5, content: '  // reformatted' }],
      }],
      totalAdditions: 1,
      totalDeletions: 1,
    };

    const result = await resolveAddressedThreads(mockOctokit, mockClient, 'owner', 'repo', 1, findings, diff);
    expect(result).toBe(0);
    expect(graphqlMock).not.toHaveBeenCalled();
  });
});

describe('buildRecapSummary', () => {
  it('includes all stats when present', () => {
    const summary = buildRecapSummary(3, 2, 1, 4);
    expect(summary).toBe('Findings: 3 new, 4 previously flagged, 1 resolved, 2 skipped (already flagged)');
  });

  it('shows only new findings when others are zero', () => {
    const summary = buildRecapSummary(5, 0, 0, 0);
    expect(summary).toBe('Findings: 5 new');
  });

  it('returns "No findings" when all counts are zero', () => {
    const summary = buildRecapSummary(0, 0, 0, 0);
    expect(summary).toBe('No findings');
  });

  it('appends collapsed dedup details with per-finding collapsible sections', () => {
    const matches = [
      { finding: makeFinding({ title: 'Unused import', file: 'src/index.ts', line: 10, severity: 'suggestion', description: 'The import is not used anywhere' }), matchedTitle: 'Remove unused import' },
    ];
    const summary = buildRecapSummary(1, 1, 0, 0, matches);
    expect(summary).toContain('Findings: 1 new, 1 skipped (already flagged)');
    expect(summary).toContain('1 finding skipped (previously flagged)');
    expect(summary).toContain('💡 "Unused import" (src/index.ts:10, suggestion)</summary>');
    expect(summary).toContain('**Description:** The import is not used anywhere');
    expect(summary).toContain('*Matches previously flagged: "Remove unused import"*');
  });

  it('sanitizes HTML in finding titles within dedup details', () => {
    const matches = [
      { finding: makeFinding({ title: '<script>alert("xss")</script>' }), matchedTitle: 'legit "title"' },
    ];
    const summary = buildRecapSummary(0, 1, 0, 0, matches);
    expect(summary).not.toContain('<script>');
    expect(summary).toContain('&lt;script&gt;');
    expect(summary).toContain('&quot;xss&quot;');
    expect(summary).toContain('legit &quot;title&quot;');
  });

  it('escapes ampersands in finding titles to prevent HTML entity injection', () => {
    const matches = [
      { finding: makeFinding({ title: 'a &lt;b&gt; issue' }), matchedTitle: 'foo & bar' },
    ];
    const summary = buildRecapSummary(0, 1, 0, 0, matches);
    expect(summary).toContain('&amp;lt;b&amp;gt;');
    expect(summary).toContain('foo &amp; bar');
    expect(summary).not.toContain('foo & bar');
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
          body: '<!-- manki:required:Null-check --> \u{1F6AB} **Required**: Missing null check\n\nDescription here.',
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
              body: '<!-- manki:required:Bug --> \u{1F6AB} **Required**: Bug found\n\nDesc.',
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
            body: '<!-- manki:nit:Style-issue --> \u{1F4DD} **Nit**: Style issue\n\nMinor.',
            author: { login: 'github-actions[bot]' },
          }],
        },
      }),
    ]);

    const state = await fetchRecapState(octokit, 'owner', 'repo', 1);
    expect(state.previousFindings[0].severity).toBe('nit');
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

  it('extracts title when confidence sub tag is present', async () => {
    const octokit = mockOctokit([
      makeThread({
        id: 't1',
        isResolved: false,
        comments: {
          nodes: [{
            body: '<!-- manki:required:Prompt-injection --> 🚫 **Required** <sub>[high confidence]</sub>: Prompt injection via unsanitized file paths\n\nDescription.',
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

describe('resolveAddressedThreads edge cases', () => {
  it('returns 0 when no open findings have threadIds', async () => {
    const mockOctokit = {} as ReturnType<typeof import('@actions/github').getOctokit>;
    const findings = [makePrevious({
      title: 'Missing null check',
      file: 'src/foo.ts',
      line: 10,
      status: 'open',
      threadId: undefined,
    })];
    const diff = {
      files: [{
        path: 'src/foo.ts',
        changeType: 'modified' as const,
        hunks: [{ oldStart: 8, oldLines: 5, newStart: 8, newLines: 5, content: 'if (x != null) {}' }],
      }],
      totalAdditions: 1,
      totalDeletions: 1,
    };

    const result = await resolveAddressedThreads(mockOctokit, null, 'owner', 'repo', 1, findings, diff);
    expect(result).toBe(0);
  });

  it('returns 0 when no findings match diff files', async () => {
    const mockOctokit = {} as ReturnType<typeof import('@actions/github').getOctokit>;
    const findings = [makePrevious({
      title: 'Missing null check',
      file: 'src/other.ts',
      line: 10,
      status: 'open',
      threadId: 'thread-1',
    })];
    const diff = {
      files: [{
        path: 'src/foo.ts',
        changeType: 'modified' as const,
        hunks: [{ oldStart: 8, oldLines: 5, newStart: 8, newLines: 5, content: 'code' }],
      }],
      totalAdditions: 1,
      totalDeletions: 1,
    };

    const result = await resolveAddressedThreads(mockOctokit, null, 'owner', 'repo', 1, findings, diff);
    expect(result).toBe(0);
  });

  it('handles Claude response with code fence wrapping', async () => {
    const graphqlMock = jest.fn().mockResolvedValue({ thread: { isResolved: true } });
    const mockOctokit = { graphql: graphqlMock } as unknown as ReturnType<typeof import('@actions/github').getOctokit>;
    const mockClient = {
      sendMessage: jest.fn().mockResolvedValue({
        content: '```json\n[{ "index": 0, "addressed": true, "reason": "fixed" }]\n```',
      }),
    } as unknown as import('./claude').ClaudeClient;

    const findings = [makePrevious({
      title: 'Missing null check',
      file: 'src/foo.ts',
      line: 10,
      status: 'open',
      threadId: 'thread-1',
    })];
    const diff = {
      files: [{
        path: 'src/foo.ts',
        changeType: 'modified' as const,
        hunks: [{ oldStart: 8, oldLines: 5, newStart: 8, newLines: 5, content: 'if (x != null) {}' }],
      }],
      totalAdditions: 1,
      totalDeletions: 1,
    };

    const result = await resolveAddressedThreads(mockOctokit, mockClient, 'owner', 'repo', 1, findings, diff);
    expect(result).toBe(1);
  });

  it('handles Claude validation error gracefully', async () => {
    const mockOctokit = {} as unknown as ReturnType<typeof import('@actions/github').getOctokit>;
    const mockClient = {
      sendMessage: jest.fn().mockRejectedValue(new Error('API error')),
    } as unknown as import('./claude').ClaudeClient;

    const findings = [makePrevious({
      title: 'Missing null check',
      file: 'src/foo.ts',
      line: 10,
      status: 'open',
      threadId: 'thread-1',
    })];
    const diff = {
      files: [{
        path: 'src/foo.ts',
        changeType: 'modified' as const,
        hunks: [{ oldStart: 8, oldLines: 5, newStart: 8, newLines: 5, content: 'code' }],
      }],
      totalAdditions: 1,
      totalDeletions: 1,
    };

    const result = await resolveAddressedThreads(mockOctokit, mockClient, 'owner', 'repo', 1, findings, diff);
    expect(result).toBe(0);
  });

  it('handles graphql resolve mutation failure gracefully', async () => {
    const graphqlMock = jest.fn().mockRejectedValue(new Error('Mutation failed'));
    const mockOctokit = { graphql: graphqlMock } as unknown as ReturnType<typeof import('@actions/github').getOctokit>;
    const mockClient = {
      sendMessage: jest.fn().mockResolvedValue({
        content: '[{ "index": 0, "addressed": true, "reason": "fixed" }]',
      }),
    } as unknown as import('./claude').ClaudeClient;

    const findings = [makePrevious({
      title: 'Missing null check',
      file: 'src/foo.ts',
      line: 10,
      status: 'open',
      threadId: 'thread-1',
    })];
    const diff = {
      files: [{
        path: 'src/foo.ts',
        changeType: 'modified' as const,
        hunks: [{ oldStart: 8, oldLines: 5, newStart: 8, newLines: 5, content: 'code' }],
      }],
      totalAdditions: 1,
      totalDeletions: 1,
    };

    const result = await resolveAddressedThreads(mockOctokit, mockClient, 'owner', 'repo', 1, findings, diff);
    expect(result).toBe(0);
  });

  it('skips resolved findings', async () => {
    const mockOctokit = {} as ReturnType<typeof import('@actions/github').getOctokit>;
    const findings = [makePrevious({
      title: 'Missing null check',
      file: 'src/foo.ts',
      line: 10,
      status: 'resolved',
      threadId: 'thread-1',
    })];
    const diff = {
      files: [{
        path: 'src/foo.ts',
        changeType: 'modified' as const,
        hunks: [{ oldStart: 8, oldLines: 5, newStart: 8, newLines: 5, content: 'code' }],
      }],
      totalAdditions: 1,
      totalDeletions: 1,
    };

    const result = await resolveAddressedThreads(mockOctokit, null, 'owner', 'repo', 1, findings, diff);
    expect(result).toBe(0);
  });

  it('handles out-of-range index in Claude response', async () => {
    const graphqlMock = jest.fn();
    const mockOctokit = { graphql: graphqlMock } as unknown as ReturnType<typeof import('@actions/github').getOctokit>;
    const mockClient = {
      sendMessage: jest.fn().mockResolvedValue({
        content: '[{ "index": 99, "addressed": true, "reason": "fixed" }]',
      }),
    } as unknown as import('./claude').ClaudeClient;

    const findings = [makePrevious({
      title: 'Missing null check',
      file: 'src/foo.ts',
      line: 10,
      status: 'open',
      threadId: 'thread-1',
    })];
    const diff = {
      files: [{
        path: 'src/foo.ts',
        changeType: 'modified' as const,
        hunks: [{ oldStart: 8, oldLines: 5, newStart: 8, newLines: 5, content: 'code' }],
      }],
      totalAdditions: 1,
      totalDeletions: 1,
    };

    const result = await resolveAddressedThreads(mockOctokit, mockClient, 'owner', 'repo', 1, findings, diff);
    expect(result).toBe(0);
    expect(graphqlMock).not.toHaveBeenCalled();
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
