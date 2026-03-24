import {
  parseFindings,
  validateSeverity,
  parseConsolidatedReview,
  determineVerdict,
  buildReviewerSystemPrompt,
  buildReviewerUserMessage,
  mergeIndividualFindings,
  selectTeam,
  tallyVotes,
} from './review';
import { Finding, ReviewerAgent, ReviewConfig, ParsedDiff, AgentVote } from './types';

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
  review_thresholds: { small: 100, medium: 500 },
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
        severity: 'blocking',
        title: 'Bug found',
        file: 'src/index.ts',
        line: 10,
        description: 'There is a bug here.',
        suggestedFix: 'Fix it like this.',
      },
    ]);

    const findings = parseFindings(json, 'TestReviewer');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('blocking');
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
    const json = '```\n[{"severity":"question","title":"Why?","file":"b.ts","line":5,"description":"Unclear code."}]\n```';

    const findings = parseFindings(json, 'Reviewer');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('question');
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
    const json = JSON.stringify([{ severity: 'blocking' }]);

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
  it('accepts blocking', () => {
    expect(validateSeverity('blocking')).toBe('blocking');
  });

  it('accepts suggestion', () => {
    expect(validateSeverity('suggestion')).toBe('suggestion');
  });

  it('accepts question', () => {
    expect(validateSeverity('question')).toBe('question');
  });

  it('defaults to suggestion for unknown values', () => {
    expect(validateSeverity('critical')).toBe('suggestion');
    expect(validateSeverity(undefined)).toBe('suggestion');
    expect(validateSeverity(null)).toBe('suggestion');
    expect(validateSeverity(42)).toBe('suggestion');
  });
});

describe('parseConsolidatedReview', () => {
  it('parses valid consolidated result', () => {
    const json = JSON.stringify({
      verdict: 'REQUEST_CHANGES',
      summary: 'Found some issues.',
      findings: [
        {
          severity: 'blocking',
          title: 'Bug',
          file: 'src/a.ts',
          line: 5,
          description: 'A bug.',
          reviewers: ['Security', 'Testing'],
        },
        {
          severity: 'suggestion',
          title: 'Style',
          file: 'src/b.ts',
          line: 10,
          description: 'Style issue.',
          reviewers: ['Architecture'],
        },
      ],
      highlights: ['Good test coverage'],
    });

    const result = parseConsolidatedReview(json);
    expect(result.verdict).toBe('REQUEST_CHANGES');
    expect(result.summary).toBe('Found some issues.');
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].reviewers).toEqual(['Security', 'Testing']);
    expect(result.highlights).toEqual(['Good test coverage']);
  });

  it('parses markdown-wrapped JSON', () => {
    const json = '```json\n{"verdict":"APPROVE","summary":"Looks good.","findings":[],"highlights":["Clean code"]}\n```';

    const result = parseConsolidatedReview(json);
    expect(result.verdict).toBe('APPROVE');
    expect(result.findings).toEqual([]);
  });

  it('throws on invalid JSON so caller can fall back to merged findings', () => {
    expect(() => parseConsolidatedReview('not json at all')).toThrow(
      /Failed to parse consolidated review/,
    );
  });

  it('sets reviewComplete true on successful parse', () => {
    const json = JSON.stringify({
      verdict: 'APPROVE',
      summary: 'Looks good.',
      findings: [],
      highlights: [],
    });
    const result = parseConsolidatedReview(json);
    expect(result.verdict).toBe('APPROVE');
    expect(result.reviewComplete).toBe(true);
  });

  it('overrides claimed verdict based on actual findings', () => {
    const json = JSON.stringify({
      verdict: 'APPROVE',
      summary: 'Looks good.',
      findings: [
        {
          severity: 'blocking',
          title: 'Bug',
          file: 'a.ts',
          line: 1,
          description: 'A bug.',
          reviewers: ['Test'],
        },
      ],
      highlights: [],
    });

    const result = parseConsolidatedReview(json);
    expect(result.verdict).toBe('REQUEST_CHANGES');
  });
});

describe('determineVerdict', () => {
  it('returns REQUEST_CHANGES when any finding is blocking', () => {
    const findings: Finding[] = [
      { severity: 'suggestion', title: 'A', file: '', line: 0, description: '', reviewers: [] },
      { severity: 'blocking', title: 'B', file: '', line: 0, description: '', reviewers: [] },
    ];
    expect(determineVerdict('APPROVE', findings)).toBe('REQUEST_CHANGES');
  });

  it('returns APPROVE when there are only suggestions', () => {
    const findings: Finding[] = [
      { severity: 'suggestion', title: 'A', file: '', line: 0, description: '', reviewers: [] },
    ];
    expect(determineVerdict('APPROVE', findings)).toBe('APPROVE');
  });

  it('returns APPROVE when there are only questions', () => {
    const findings: Finding[] = [
      { severity: 'question', title: 'A', file: '', line: 0, description: '', reviewers: [] },
    ];
    expect(determineVerdict('APPROVE', findings)).toBe('APPROVE');
  });

  it('returns APPROVE when there are no findings', () => {
    expect(determineVerdict('REQUEST_CHANGES', [])).toBe('APPROVE');
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

describe('mergeIndividualFindings', () => {
  it('collects findings from multiple reviewers', () => {
    const result = mergeIndividualFindings([
      { reviewer: 'Security', findings: [makeFinding({ title: 'Bug A', file: 'a.ts', line: 1 })] },
      { reviewer: 'Style', findings: [makeFinding({ title: 'Style B', file: 'b.ts', line: 5 })] },
    ]);
    expect(result.findings).toHaveLength(2);
    expect(result.summary).toContain('2 findings from 2 reviewers');
  });

  it('de-duplicates findings on same file and nearby lines with similar titles', () => {
    const result = mergeIndividualFindings([
      { reviewer: 'Security', findings: [makeFinding({ title: 'Null check missing', file: 'a.ts', line: 10, reviewers: ['Security'] })] },
      { reviewer: 'Testing', findings: [makeFinding({ title: 'Null check missing', file: 'a.ts', line: 11, reviewers: ['Testing'] })] },
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].reviewers).toContain('Security');
    expect(result.findings[0].reviewers).toContain('Testing');
  });

  it('keeps findings on different files even with same title', () => {
    const result = mergeIndividualFindings([
      { reviewer: 'A', findings: [makeFinding({ title: 'Bug', file: 'a.ts', line: 10 })] },
      { reviewer: 'B', findings: [makeFinding({ title: 'Bug', file: 'b.ts', line: 10 })] },
    ]);
    expect(result.findings).toHaveLength(2);
  });

  it('keeps findings on same file but distant lines', () => {
    const result = mergeIndividualFindings([
      { reviewer: 'A', findings: [makeFinding({ title: 'Bug', file: 'a.ts', line: 10 })] },
      { reviewer: 'B', findings: [makeFinding({ title: 'Bug', file: 'a.ts', line: 100 })] },
    ]);
    expect(result.findings).toHaveLength(2);
  });

  it('returns REQUEST_CHANGES when any finding is blocking', () => {
    const result = mergeIndividualFindings([
      { reviewer: 'A', findings: [makeFinding({ severity: 'blocking' })] },
    ]);
    expect(result.verdict).toBe('REQUEST_CHANGES');
  });

  it('returns APPROVE when no blocking findings', () => {
    const result = mergeIndividualFindings([
      { reviewer: 'A', findings: [makeFinding({ severity: 'suggestion' })] },
    ]);
    expect(result.verdict).toBe('APPROVE');
  });

  it('sets reviewComplete to true', () => {
    const result = mergeIndividualFindings([]);
    expect(result.reviewComplete).toBe(true);
  });

  it('does not add duplicate reviewer names', () => {
    const result = mergeIndividualFindings([
      { reviewer: 'A', findings: [makeFinding({ title: 'Bug', file: 'a.ts', line: 10, reviewers: ['A'] })] },
      { reviewer: 'A', findings: [makeFinding({ title: 'Bug', file: 'a.ts', line: 10, reviewers: ['A'] })] },
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].reviewers).toEqual(['A']);
  });

  it('does not match short titles as substrings', () => {
    const result = mergeIndividualFindings([
      { reviewer: 'A', findings: [makeFinding({ title: 'Bug', file: 'a.ts', line: 10 })] },
      { reviewer: 'B', findings: [makeFinding({ title: 'Bug in error handling logic', file: 'a.ts', line: 11 })] },
    ]);
    expect(result.findings).toHaveLength(2);
  });

  it('matches long titles that are substrings of each other', () => {
    const result = mergeIndividualFindings([
      { reviewer: 'A', findings: [makeFinding({ title: 'Null check missing in handler', file: 'a.ts', line: 10, reviewers: ['A'] })] },
      { reviewer: 'B', findings: [makeFinding({ title: 'Null check missing in handler for edge case', file: 'a.ts', line: 11, reviewers: ['B'] })] },
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].reviewers).toContain('A');
    expect(result.findings[0].reviewers).toContain('B');
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
    const diff = makeDiff({ totalAdditions: 300, totalDeletions: 300 });
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
    const config = makeConfig({ review_level: 'large' });
    const roster = selectTeam(diff, config, [custom]);
    expect(roster.agents.map(a => a.name)).toContain('Protocol Expert');
  });

  it('respects fixed review_level override', () => {
    const diff = makeDiff({ totalAdditions: 10, totalDeletions: 5 });
    const config = makeConfig({ review_level: 'large' });
    const roster = selectTeam(diff, config);
    expect(roster.level).toBe('large');
    expect(roster.agents).toHaveLength(7);
  });
});

describe('tallyVotes', () => {
  const findingA = { ...makeFinding({ title: 'Bug A', severity: 'suggestion' }), index: 0 };
  const findingB = { ...makeFinding({ title: 'Bug B', severity: 'suggestion' }), index: 1 };

  it('keeps finding when majority agrees', () => {
    const votes: AgentVote[] = [
      { agentName: 'A', findingIndex: 0, vote: 'agree', reason: 'valid' },
      { agentName: 'B', findingIndex: 0, vote: 'agree', reason: 'valid' },
      { agentName: 'C', findingIndex: 0, vote: 'disagree', reason: 'nah' },
    ];
    const results = tallyVotes([findingA], votes, 3);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Bug A');
  });

  it('drops finding when majority disagrees', () => {
    const votes: AgentVote[] = [
      { agentName: 'A', findingIndex: 0, vote: 'disagree', reason: 'false positive' },
      { agentName: 'B', findingIndex: 0, vote: 'disagree', reason: 'false positive' },
      { agentName: 'C', findingIndex: 0, vote: 'agree', reason: 'valid' },
    ];
    const results = tallyVotes([findingA], votes, 3);
    expect(results).toHaveLength(0);
  });

  it('escalates to blocking when all voters unanimously agree', () => {
    const votes: AgentVote[] = [
      { agentName: 'A', findingIndex: 0, vote: 'agree', reason: 'valid' },
      { agentName: 'B', findingIndex: 0, vote: 'agree', reason: 'valid' },
      { agentName: 'C', findingIndex: 0, vote: 'agree', reason: 'valid' },
    ];
    const results = tallyVotes([findingA], votes, 3);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe('blocking');
  });

  it('downgrades to suggestion on split vote', () => {
    const finding = { ...makeFinding({ title: 'Mixed', severity: 'blocking' }), index: 0 };
    const votes: AgentVote[] = [
      { agentName: 'A', findingIndex: 0, vote: 'agree', reason: 'valid' },
      { agentName: 'B', findingIndex: 0, vote: 'disagree', reason: 'nah' },
      { agentName: 'C', findingIndex: 0, vote: 'disagree', reason: 'nah' },
      { agentName: 'D', findingIndex: 0, vote: 'agree', reason: 'valid' },
      // 2 agree, 2 disagree out of 5 total team — neither reaches majority (3)
    ];
    const results = tallyVotes([finding], votes, 5);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe('suggestion');
  });

  it('keeps finding as-is when no votes are cast', () => {
    const results = tallyVotes([findingA], [], 3);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Bug A');
    expect(results[0].severity).toBe('suggestion');
  });

  it('escalates to blocking when escalate vote present with majority agree', () => {
    const votes: AgentVote[] = [
      { agentName: 'A', findingIndex: 0, vote: 'agree', reason: 'valid' },
      { agentName: 'B', findingIndex: 0, vote: 'escalate', reason: 'worse than reported' },
      { agentName: 'C', findingIndex: 0, vote: 'disagree', reason: 'nah' },
    ];
    const results = tallyVotes([findingA], votes, 3);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe('blocking');
  });

  it('collects agreeing voter names in reviewers array', () => {
    const votes: AgentVote[] = [
      { agentName: 'Alpha', findingIndex: 0, vote: 'agree', reason: 'valid' },
      { agentName: 'Beta', findingIndex: 0, vote: 'agree', reason: 'valid' },
      { agentName: 'Gamma', findingIndex: 0, vote: 'disagree', reason: 'nah' },
    ];
    const results = tallyVotes([findingA], votes, 3);
    expect(results[0].reviewers).toEqual(['Alpha', 'Beta']);
  });

  it('does not escalate question findings to blocking on unanimous agree', () => {
    const questionFinding = { ...makeFinding({ title: 'Unclear code', severity: 'question' as const }), index: 0 };
    const votes: AgentVote[] = [
      { agentName: 'A', findingIndex: 0, vote: 'agree', reason: 'valid' },
      { agentName: 'B', findingIndex: 0, vote: 'agree', reason: 'valid' },
      { agentName: 'C', findingIndex: 0, vote: 'agree', reason: 'valid' },
    ];
    const results = tallyVotes([questionFinding], votes, 3);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe('question');
  });

  it('does not escalate blocking findings further on unanimous agree', () => {
    const blockingFinding = { ...makeFinding({ title: 'Real bug', severity: 'blocking' as const }), index: 0 };
    const votes: AgentVote[] = [
      { agentName: 'A', findingIndex: 0, vote: 'agree', reason: 'valid' },
      { agentName: 'B', findingIndex: 0, vote: 'agree', reason: 'valid' },
      { agentName: 'C', findingIndex: 0, vote: 'agree', reason: 'valid' },
    ];
    const results = tallyVotes([blockingFinding], votes, 3);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe('blocking');
  });

  it('handles multiple findings independently', () => {
    const votes: AgentVote[] = [
      { agentName: 'A', findingIndex: 0, vote: 'agree', reason: 'valid' },
      { agentName: 'B', findingIndex: 0, vote: 'agree', reason: 'valid' },
      { agentName: 'A', findingIndex: 1, vote: 'disagree', reason: 'nah' },
      { agentName: 'B', findingIndex: 1, vote: 'disagree', reason: 'nah' },
    ];
    const results = tallyVotes([findingA, findingB], votes, 3);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Bug A');
  });
});
