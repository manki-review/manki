import {
  parseFindings,
  validateSeverity,
  determineVerdict,
  buildReviewerSystemPrompt,
  buildReviewerUserMessage,
  selectTeam,
  titlesMatch,
  truncateDiff,
  AGENT_POOL,
} from './review';
import { Finding, ReviewerAgent, ReviewConfig, ParsedDiff } from './types';

const makeConfig = (overrides: Partial<ReviewConfig> = {}): ReviewConfig => ({
  model: 'claude-opus-4-6',
  auto_review: true,
  auto_approve: true,
  review_language: 'en',
  include_paths: ['**/*'],
  exclude_paths: [],
  max_diff_lines: 10000,
  reviewers: [],
  instructions: '',
  review_level: 'auto',
  review_thresholds: { small: 200, medium: 1000 },
  memory: { enabled: false, repo: '' },
  ...overrides,
});

const makeDiff = (overrides: Partial<ParsedDiff> = {}): ParsedDiff => ({
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  ...overrides,
});

const makeFinding = (overrides: Partial<Finding> = {}): Finding => ({
  severity: 'suggestion',
  title: 'Test finding',
  file: 'src/a.ts',
  line: 10,
  description: 'A test finding.',
  reviewers: ['Reviewer A'],
  ...overrides,
});

describe('parseFindings', () => {
  it('parses valid JSON array', () => {
    const json = JSON.stringify([
      {
        severity: 'required',
        title: 'Bug found',
        file: 'src/index.ts',
        line: 10,
        description: 'There is a bug here.',
        suggestedFix: 'Fix it like this.',
      },
    ]);

    const findings = parseFindings(json, 'TestReviewer');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('required');
    expect(findings[0].title).toBe('Bug found');
    expect(findings[0].file).toBe('src/index.ts');
    expect(findings[0].line).toBe(10);
    expect(findings[0].description).toBe('There is a bug here.');
    expect(findings[0].suggestedFix).toBe('Fix it like this.');
    expect(findings[0].reviewers).toEqual(['TestReviewer']);
  });

  it('parses markdown-wrapped JSON', () => {
    const json = '```json\n[{"severity":"suggestion","title":"Naming","file":"a.ts","line":1,"description":"Rename this."}]\n```';

    const findings = parseFindings(json, 'Reviewer');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('suggestion');
  });

  it('parses markdown-wrapped JSON without language tag', () => {
    const json = '```\n[{"severity":"nit","title":"Why?","file":"b.ts","line":5,"description":"Unclear code."}]\n```';

    const findings = parseFindings(json, 'Reviewer');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('nit');
  });

  it('returns empty array for invalid JSON', () => {
    const findings = parseFindings('this is not json', 'Reviewer');
    expect(findings).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    const findings = parseFindings('{"not": "an array"}', 'Reviewer');
    expect(findings).toEqual([]);
  });

  it('parses empty array', () => {
    const findings = parseFindings('[]', 'Reviewer');
    expect(findings).toEqual([]);
  });

  it('handles missing fields gracefully', () => {
    const json = JSON.stringify([{ severity: 'required' }]);

    const findings = parseFindings(json, 'Reviewer');
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe('Untitled finding');
    expect(findings[0].file).toBe('');
    expect(findings[0].line).toBe(0);
    expect(findings[0].description).toBe('');
    expect(findings[0].suggestedFix).toBeUndefined();
  });

  it('defaults unknown severity to suggestion', () => {
    const json = JSON.stringify([{
      severity: 'critical',
      title: 'Test',
      file: 'a.ts',
      line: 1,
      description: 'Desc',
    }]);

    const findings = parseFindings(json, 'Reviewer');
    expect(findings[0].severity).toBe('suggestion');
  });
});

describe('validateSeverity', () => {
  it('accepts required', () => {
    expect(validateSeverity('required')).toBe('required');
  });

  it('accepts suggestion', () => {
    expect(validateSeverity('suggestion')).toBe('suggestion');
  });

  it('accepts nit', () => {
    expect(validateSeverity('nit')).toBe('nit');
  });

  it('accepts ignore', () => {
    expect(validateSeverity('ignore')).toBe('ignore');
  });

  it('defaults to suggestion for unknown values', () => {
    expect(validateSeverity('critical')).toBe('suggestion');
    expect(validateSeverity('blocking')).toBe('suggestion');
    expect(validateSeverity('question')).toBe('suggestion');
    expect(validateSeverity(undefined)).toBe('suggestion');
    expect(validateSeverity(null)).toBe('suggestion');
    expect(validateSeverity(42)).toBe('suggestion');
  });
});

describe('determineVerdict', () => {
  it('returns REQUEST_CHANGES when any finding is required', () => {
    const findings: Finding[] = [
      makeFinding({ severity: 'suggestion' }),
      makeFinding({ severity: 'required' }),
    ];
    expect(determineVerdict(findings)).toBe('REQUEST_CHANGES');
  });

  it('returns APPROVE when there are only suggestions', () => {
    const findings: Finding[] = [makeFinding({ severity: 'suggestion' })];
    expect(determineVerdict(findings)).toBe('APPROVE');
  });

  it('returns APPROVE when there are only nits', () => {
    const findings: Finding[] = [makeFinding({ severity: 'nit' })];
    expect(determineVerdict(findings)).toBe('APPROVE');
  });

  it('returns APPROVE when there are only ignores', () => {
    const findings: Finding[] = [makeFinding({ severity: 'ignore' })];
    expect(determineVerdict(findings)).toBe('APPROVE');
  });

  it('returns APPROVE when there are no findings', () => {
    expect(determineVerdict([])).toBe('APPROVE');
  });
});

describe('buildReviewerSystemPrompt', () => {
  const reviewer: ReviewerAgent = {
    name: 'Security & Correctness',
    focus: 'bugs, vulnerabilities, memory safety',
  };

  it('includes reviewer focus', () => {
    const prompt = buildReviewerSystemPrompt(reviewer, makeConfig());
    expect(prompt).toContain('bugs, vulnerabilities, memory safety');
  });

  it('includes reviewer name', () => {
    const prompt = buildReviewerSystemPrompt(reviewer, makeConfig());
    expect(prompt).toContain('Security & Correctness');
  });

  it('includes custom instructions when present', () => {
    const config = makeConfig({ instructions: 'Focus on TypeScript best practices.' });
    const prompt = buildReviewerSystemPrompt(reviewer, config);
    expect(prompt).toContain('Focus on TypeScript best practices.');
    expect(prompt).toContain('Additional Instructions');
  });

  it('omits additional instructions section when instructions is empty', () => {
    const prompt = buildReviewerSystemPrompt(reviewer, makeConfig());
    expect(prompt).not.toContain('Additional Instructions');
  });
});

describe('buildReviewerUserMessage', () => {
  it('includes diff', () => {
    const message = buildReviewerUserMessage('+ added line', '');
    expect(message).toContain('+ added line');
    expect(message).toContain('Pull Request Diff');
  });

  it('includes repo context when provided', () => {
    const message = buildReviewerUserMessage('diff content', 'This is a TypeScript project.');
    expect(message).toContain('Repository Context');
    expect(message).toContain('This is a TypeScript project.');
  });

  it('omits repo context when empty', () => {
    const message = buildReviewerUserMessage('diff content', '');
    expect(message).not.toContain('Repository Context');
  });
});

describe('parseFindings with extractJSON', () => {
  it('extracts JSON array from text with preamble', () => {
    const input = 'Here are my findings:\n\n[{"severity":"blocking","title":"Bug","file":"a.ts","line":1,"description":"Crash"}]';
    const findings = parseFindings(input, 'Test');
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe('Bug');
  });
});

describe('selectTeam', () => {
  it('selects small team for diffs under small threshold', () => {
    const diff = makeDiff({ totalAdditions: 30, totalDeletions: 20 });
    const config = makeConfig();
    const roster = selectTeam(diff, config);
    expect(roster.level).toBe('small');
    expect(roster.agents).toHaveLength(3);
    expect(roster.lineCount).toBe(50);
  });

  it('selects medium team for diffs between small and medium thresholds', () => {
    const diff = makeDiff({ totalAdditions: 150, totalDeletions: 100 });
    const config = makeConfig();
    const roster = selectTeam(diff, config);
    expect(roster.level).toBe('medium');
    expect(roster.agents).toHaveLength(5);
  });

  it('selects large team for diffs above medium threshold', () => {
    const diff = makeDiff({ totalAdditions: 600, totalDeletions: 600 });
    const config = makeConfig();
    const roster = selectTeam(diff, config);
    expect(roster.level).toBe('large');
    expect(roster.agents).toHaveLength(7);
  });

  it('auto level picks correct size based on line count', () => {
    const config = makeConfig({ review_level: 'auto', review_thresholds: { small: 50, medium: 200 } });

    const small = selectTeam(makeDiff({ totalAdditions: 10, totalDeletions: 10 }), config);
    expect(small.level).toBe('small');

    const medium = selectTeam(makeDiff({ totalAdditions: 60, totalDeletions: 60 }), config);
    expect(medium.level).toBe('medium');

    const large = selectTeam(makeDiff({ totalAdditions: 150, totalDeletions: 100 }), config);
    expect(large.level).toBe('large');
  });

  it('always includes core agents (Security, Architecture, Correctness)', () => {
    const diff = makeDiff({ totalAdditions: 10, totalDeletions: 5 });
    const config = makeConfig();
    const roster = selectTeam(diff, config);
    expect(roster.agents.map(a => a.name)).toContain('Security & Safety');
    expect(roster.agents.map(a => a.name)).toContain('Architecture & Design');
    expect(roster.agents.map(a => a.name)).toContain('Correctness & Logic');
  });

  it('includes custom reviewers in pool and gives them a scoring boost', () => {
    const custom: ReviewerAgent = { name: 'Protocol Expert', focus: 'protocol compliance' };
    const diff = makeDiff({
      totalAdditions: 300,
      totalDeletions: 300,
      files: [{ path: 'src/main.ts', changeType: 'modified', hunks: [] }],
    });
    const config = makeConfig({ review_level: 'medium' });
    const roster = selectTeam(diff, config, [custom]);
    // The +1 scoring boost should place a custom reviewer among the top candidates
    expect(roster.agents.map(a => a.name)).toContain('Protocol Expert');
  });

  it('does not duplicate when custom reviewer has same name as core agent', () => {
    const custom: ReviewerAgent = { name: 'Security & Safety', focus: 'custom security focus' };
    const diff = makeDiff({ totalAdditions: 300, totalDeletions: 300 });
    const config = makeConfig({ review_level: 'large' });
    const roster = selectTeam(diff, config, [custom]);
    const securityCount = roster.agents.filter(a => a.name === 'Security & Safety').length;
    expect(securityCount).toBe(1);
  });

  it('includes custom reviewers even for small teams', () => {
    const custom: ReviewerAgent = { name: 'Protocol Expert', focus: 'protocol compliance' };
    const diff = makeDiff({ totalAdditions: 10, totalDeletions: 5 });
    const config = makeConfig({ review_level: 'small' });
    const roster = selectTeam(diff, config, [custom]);
    expect(roster.agents.map(a => a.name)).toContain('Protocol Expert');
    // 3 core + 1 custom
    expect(roster.agents.length).toBeGreaterThanOrEqual(4);
  });

  it('respects fixed review_level override', () => {
    const diff = makeDiff({ totalAdditions: 10, totalDeletions: 5 });
    const config = makeConfig({ review_level: 'large' });
    const roster = selectTeam(diff, config);
    expect(roster.level).toBe('large');
    expect(roster.agents).toHaveLength(7);
  });

  it('scores testing agent higher when test files are in the diff', () => {
    const diff = makeDiff({
      totalAdditions: 300,
      totalDeletions: 300,
      files: [
        { path: 'src/review.test.ts', changeType: 'modified', hunks: [] },
        { path: 'src/review.ts', changeType: 'modified', hunks: [] },
      ],
    });
    const config = makeConfig({ review_level: 'medium' });
    const roster = selectTeam(diff, config);
    expect(roster.agents.map(a => a.name)).toContain('Testing & Coverage');
  });

  it('does not add scored agents beyond teamSize when custom reviewers are present', () => {
    const customs: ReviewerAgent[] = [
      { name: 'Custom A', focus: 'custom a' },
      { name: 'Custom B', focus: 'custom b' },
    ];
    const diff = makeDiff({ totalAdditions: 10, totalDeletions: 5 });
    const config = makeConfig({ review_level: 'small' });
    const roster = selectTeam(diff, config, customs);
    // 3 core + 2 custom = 5, teamSize is 3 but custom reviewers are always included.
    // The scoring loop should not add any more agents beyond the 5 already selected.
    const nonCoreNonCustom = roster.agents.filter(
      a => !['Security & Safety', 'Architecture & Design', 'Correctness & Logic', 'Custom A', 'Custom B'].includes(a.name),
    );
    expect(nonCoreNonCustom).toHaveLength(0);
  });
});

describe('AGENT_POOL', () => {
  it('has exactly 7 agents', () => {
    expect(AGENT_POOL).toHaveLength(7);
  });

  it('is frozen and cannot be mutated', () => {
    expect(Object.isFrozen(AGENT_POOL)).toBe(true);
  });
});

describe('titlesMatch', () => {
  it('matches exact equal titles', () => {
    expect(titlesMatch('Null check missing', 'Null check missing')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(titlesMatch('Null Check Missing', 'null check missing')).toBe(true);
  });

  it('does not match short titles as substrings', () => {
    expect(titlesMatch('Bug', 'Bug in error handling logic')).toBe(false);
  });

  it('matches long titles where one is a substring of the other', () => {
    expect(titlesMatch('Null check missing in handler', 'Null check missing in handler for edge case')).toBe(true);
  });

  it('does not match completely different long titles', () => {
    expect(titlesMatch('Memory leak in connection pool', 'SQL injection in query builder')).toBe(false);
  });
});

describe('buildReviewerUserMessage truncation', () => {
  it('truncates diff at newline boundary when exceeding 50000 chars', () => {
    const longDiff = ('a'.repeat(99) + '\n').repeat(600); // 60000 chars
    const message = buildReviewerUserMessage(longDiff, '');
    expect(message).toContain('... (truncated)');
    expect(message.length).toBeLessThan(longDiff.length);
  });

  it('does not truncate diff under 50000 chars', () => {
    const shortDiff = 'short diff content';
    const message = buildReviewerUserMessage(shortDiff, '');
    expect(message).not.toContain('... (truncated)');
    expect(message).toContain(shortDiff);
  });
});

describe('truncateDiff', () => {
  it('returns original when under maxLength', () => {
    const diff = 'short diff';
    expect(truncateDiff(diff)).toBe(diff);
  });

  it('truncates at last newline before maxLength', () => {
    const lines = 'line one\nline two\nline three\n';
    const result = truncateDiff(lines, 15);
    expect(result).toBe('line one\n... (truncated)');
  });

  it('truncates at maxLength when no newline found', () => {
    const noNewlines = 'a'.repeat(100);
    const result = truncateDiff(noNewlines, 50);
    expect(result).toBe('a'.repeat(50) + '\n... (truncated)');
  });

  it('returns original when exactly at maxLength', () => {
    const exact = 'a'.repeat(50);
    expect(truncateDiff(exact, 50)).toBe(exact);
  });
});

describe('titlesMatch boundary', () => {
  it('rejects 9-char title as substring match', () => {
    expect(titlesMatch('123456789', '123456789 extended with more text')).toBe(false);
  });

  it('accepts exactly 10-char title as substring match', () => {
    expect(titlesMatch('1234567890', '1234567890 extended with more text')).toBe(true);
  });

  it('accepts 11-char title as substring match', () => {
    expect(titlesMatch('12345678901', '12345678901 extended with more text')).toBe(true);
  });
});

describe('selectTeam dependency file scoring', () => {
  it('falls back to auto sizing for unrecognized review_level values', () => {
    const diff = makeDiff({ totalAdditions: 10, totalDeletions: 5 });
    // Force an invalid review_level at runtime (e.g. from misconfigured YAML)
    const config = makeConfig({ review_level: 'thorough' as 'large' });
    const roster = selectTeam(diff, config);
    // Unrecognized levels fall back to auto; 15 lines < 200 threshold = small
    expect(roster.level).toBe('small');
    expect(roster.agents).toHaveLength(3);
  });

  it('scores Dependencies agent higher when package.json is in the diff', () => {
    const diff = makeDiff({
      totalAdditions: 300,
      totalDeletions: 300,
      files: [
        { path: 'package.json', changeType: 'modified', hunks: [] },
        { path: 'src/index.ts', changeType: 'modified', hunks: [] },
      ],
    });
    const config = makeConfig({ review_level: 'medium' });
    const roster = selectTeam(diff, config);
    expect(roster.agents.map(a => a.name)).toContain('Dependencies & Integration');
  });

  it('scores Dependencies agent higher when Cargo.toml is in the diff', () => {
    const diff = makeDiff({
      totalAdditions: 300,
      totalDeletions: 300,
      files: [
        { path: 'Cargo.toml', changeType: 'modified', hunks: [] },
      ],
    });
    const config = makeConfig({ review_level: 'medium' });
    const roster = selectTeam(diff, config);
    expect(roster.agents.map(a => a.name)).toContain('Dependencies & Integration');
  });
});
