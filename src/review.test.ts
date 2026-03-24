import {
  parseFindings,
  validateSeverity,
  parseConsolidatedReview,
  determineVerdict,
  buildReviewerSystemPrompt,
  buildReviewerUserMessage,
} from './review';
import { Finding, ReviewerAgent, ReviewConfig } from './types';

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
  memory: { enabled: false, repo: '' },
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

  it('returns fallback with COMMENT verdict and reviewComplete false for invalid JSON', () => {
    const result = parseConsolidatedReview('not json at all');
    expect(result.verdict).toBe('COMMENT');
    expect(result.summary).toContain('consolidation failed');
    expect(result.findings).toEqual([]);
    expect(result.highlights).toEqual([]);
    expect(result.reviewComplete).toBe(false);
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
