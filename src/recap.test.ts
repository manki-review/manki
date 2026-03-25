import { Finding } from './types';
import { Suppression } from './memory';
import { deduplicateFindings, buildRecapSummary, PreviousFinding, resolveAddressedThreads } from './recap';

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
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
  });

  it('detects fuzzy line match within +/-5 lines', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 45 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
  });

  it('does not match different file with same title', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/bar.ts', line: 42 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });

  it('does not match different title with same file and line', () => {
    const findings = [makeFinding({ title: 'Unused variable', file: 'src/foo.ts', line: 42 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];

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
    const previous = [makePrevious({ title: '', file: 'src/foo.ts', line: 42 })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });

  it('does not match when finding title is shorter than 3 characters', () => {
    const findings = [makeFinding({ title: 'AB', file: 'src/foo.ts', line: 42 })];
    const previous = [makePrevious({ title: 'AB', file: 'src/foo.ts', line: 42 })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });

  it('does not deduplicate against resolved previous findings (regression detection)', () => {
    const findings = [makeFinding({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42, status: 'resolved' })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
  });

  it('deduplicates against open previous findings but not resolved ones', () => {
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
    expect(result.unique[0].title).toBe('Unused import');
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].title).toBe('Missing null check');
  });

  it('matches by title substring', () => {
    const findings = [makeFinding({ title: 'Missing null check in processBlock', file: 'src/foo.ts', line: 42 })];
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/foo.ts', line: 42 })];

    const result = deduplicateFindings(findings, previous);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
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
    const previous = [makePrevious({ title: 'Missing null check', file: 'src/bar.ts', line: 42 })];
    const suppressions = [makeSuppression({ pattern: 'test finding' })];

    const result = deduplicateFindings(findings, previous, suppressions);
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0].title).toBe('Unused import');
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].title).toBe('Missing null check');
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
});
