import { buildDashboard, formatFindingComment, formatStatsJson, formatStatsOneLiner, mapVerdictToEvent, BOT_MARKER, buildNitIssueBody, getSeverityLabel, postReview, resolveReferences, sanitizeMarkdown, sanitizeFilePath, truncateBody, dynamicFence, safeTruncate, fetchFileContents, fetchLinkedIssues, fetchSubdirClaudeMd, updateProgressComment, postProgressComment, updateProgressDashboard, dismissPreviousReviews, reactToIssueComment, reactToReviewComment, createNitIssue, fetchPRDiff, fetchConfigFile, fetchRepoContext, getSeverityEmoji } from './github';
import { DashboardData, Finding, ParsedDiff, ReviewMetadata, ReviewResult, ReviewStats } from './types';

describe('formatFindingComment', () => {
  const baseFinding: Finding = {
    severity: 'required',
    title: 'Null pointer dereference',
    file: 'src/main.ts',
    line: 42,
    description: 'This code will throw if the value is undefined.',
    reviewers: ['Security & Correctness'],
  };

  it('formats a required finding with correct emoji and label', () => {
    const comment = formatFindingComment(baseFinding);
    expect(comment).toContain('🚫 **Required**');
    expect(comment).toContain(baseFinding.title);
    expect(comment).toContain(baseFinding.description);
  });

  it('formats a suggestion finding with correct emoji and label', () => {
    const finding: Finding = { ...baseFinding, severity: 'suggestion' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('💡 **Suggestion**');
  });

  it('formats a nit finding with correct emoji and label', () => {
    const finding: Finding = { ...baseFinding, severity: 'nit' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('📝 **Nit**');
  });

  it('formats an ignore finding with correct emoji and label', () => {
    const finding: Finding = { ...baseFinding, severity: 'ignore' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('⚪ **Ignore**');
    expect(comment).toContain('<!-- manki:ignore:');
  });

  it('shows short suggested fix inline without collapsible wrapper', () => {
    const finding: Finding = { ...baseFinding, suggestedFix: 'if (value != null) { use(value); }' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('```suggestion');
    expect(comment).toContain('if (value != null) { use(value); }');
    expect(comment).not.toContain('<summary>Suggested fix</summary>');
  });

  it('wraps long suggested fix in a collapsible details section', () => {
    const longFix = 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;';
    const finding: Finding = { ...baseFinding, suggestedFix: longFix };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('<details>\n<summary>Suggested fix</summary>');
    expect(comment).toContain('```suggestion');
    expect(comment).toContain(longFix);
  });

  it('omits suggested fix section when not present', () => {
    const comment = formatFindingComment(baseFinding);
    expect(comment).not.toContain('<summary>Suggested fix</summary>');
    expect(comment).not.toContain('```suggestion');
  });

  it('includes AI context as a collapsible JSON block', () => {
    const comment = formatFindingComment(baseFinding);
    expect(comment).toContain('<details>\n<summary>AI context</summary>');
    expect(comment).toContain('```json');
    const jsonMatch = comment.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed.file).toBe(baseFinding.file);
    expect(parsed.line).toBe(baseFinding.line);
    expect(parsed.severity).toBe(baseFinding.severity);
    expect(parsed.title).toBe(baseFinding.title);
    expect(parsed.flaggedBy).toEqual(baseFinding.reviewers);
    expect(parsed.confidence).toBeUndefined();
    expect(parsed.fix).toBeUndefined();
  });

  it('includes fix and confidence in AI context JSON when present', () => {
    const finding: Finding = { ...baseFinding, suggestedFix: 'if (value != null) { use(value); }', judgeConfidence: 'high' };
    const comment = formatFindingComment(finding);
    const jsonMatch = comment.match(/```json\n([\s\S]*?)\n```/);
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed.fix).toBe('if (value != null) { use(value); }');
    expect(parsed.confidence).toBe('high');
  });

  it('truncates long suggestedFix in AI context JSON to 200 chars', () => {
    const longFix = 'a'.repeat(250);
    const finding: Finding = { ...baseFinding, suggestedFix: longFix };
    const comment = formatFindingComment(finding);
    const jsonMatch = comment.match(/```json\n([\s\S]*?)\n```/);
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed.fix.length).toBe(200);
  });

  it('includes flaggedBy in AI context JSON instead of visible attribution', () => {
    const comment = formatFindingComment(baseFinding);
    expect(comment).not.toContain('Flagged by');
    const jsonMatch = comment.match(/```json\n([\s\S]*?)\n```/);
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed.flaggedBy).toEqual(['Security & Correctness']);
  });

  it('includes multiple reviewers in AI context flaggedBy', () => {
    const finding: Finding = { ...baseFinding, reviewers: ['Security', 'Testing'] };
    const comment = formatFindingComment(finding);
    expect(comment).not.toContain('Flagged by');
    const jsonMatch = comment.match(/```json\n([\s\S]*?)\n```/);
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed.flaggedBy).toEqual(['Security', 'Testing']);
  });

  it('includes empty flaggedBy when reviewers is empty', () => {
    const finding: Finding = { ...baseFinding, reviewers: [] };
    const comment = formatFindingComment(finding);
    expect(comment).not.toContain('Flagged by');
    const jsonMatch = comment.match(/```json\n([\s\S]*?)\n```/);
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed.flaggedBy).toEqual([]);
  });

  it('includes metadata marker with severity and sanitized title', () => {
    const comment = formatFindingComment(baseFinding);
    expect(comment).toContain('<!-- manki:required:Null-pointer-dereference -->');
  });

  it('sanitizes special characters in metadata marker title', () => {
    const finding: Finding = { ...baseFinding, title: 'Bug: foo() returns "bar"!' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('<!-- manki:required:Bug--foo---returns--bar-- -->');
  });

  it('shows judge confidence when present', () => {
    const finding: Finding = { ...baseFinding, judgeConfidence: 'high' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('<sub>[high confidence]</sub>');
  });

  it('shows medium judge confidence', () => {
    const finding: Finding = { ...baseFinding, judgeConfidence: 'medium' };
    const comment = formatFindingComment(finding);
    expect(comment).toContain('<sub>[medium confidence]</sub>');
  });

  it('omits judge confidence when absent', () => {
    const comment = formatFindingComment(baseFinding);
    expect(comment).not.toContain('confidence]');
  });
});

describe('mapVerdictToEvent', () => {
  it('maps APPROVE to APPROVE', () => {
    expect(mapVerdictToEvent('APPROVE')).toBe('APPROVE');
  });

  it('maps COMMENT to COMMENT', () => {
    expect(mapVerdictToEvent('COMMENT')).toBe('COMMENT');
  });

  it('maps REQUEST_CHANGES to REQUEST_CHANGES', () => {
    expect(mapVerdictToEvent('REQUEST_CHANGES')).toBe('REQUEST_CHANGES');
  });
});

describe('BOT_MARKER', () => {
  it('is an HTML comment', () => {
    expect(BOT_MARKER).toMatch(/^<!--.*-->$/);
  });
});

describe('buildNitIssueBody', () => {
  const nit: Finding = {
    severity: 'nit',
    title: 'Use const instead of let',
    file: 'src/utils.ts',
    line: 10,
    description: 'Variable is never reassigned.',
    reviewers: ['Style'],
  };

  const suggestion: Finding = {
    severity: 'suggestion',
    title: 'Is this timeout intentional?',
    file: 'src/client.ts',
    line: 55,
    description: 'The timeout of 60s seems high for this endpoint.',
    reviewers: ['Performance'],
  };

  const required: Finding = {
    severity: 'required',
    title: 'Null dereference',
    file: 'src/main.ts',
    line: 1,
    description: 'Will crash at runtime.',
    reviewers: ['Security'],
  };

  it('filters to only nit findings', () => {
    const body = buildNitIssueBody(42, [required, nit, suggestion], 'testowner', 'testrepo', 'abc123');
    expect(body).toContain('Use const instead of let');
    expect(body).not.toContain('Null dereference');
    expect(body).not.toContain('Is this timeout intentional?');
  });

  it('formats checklist items with file and line in details summary', () => {
    const body = buildNitIssueBody(42, [nit], 'testowner', 'testrepo', 'abc123');
    expect(body).toContain('- [ ] <details><summary>');
    expect(body).toContain('<code>src/utils.ts:10</code>');
    expect(body).toContain('Variable is never reassigned.');
  });

  it('includes suggested fix when present', () => {
    const withFix: Finding = { ...nit, suggestedFix: 'const x = 1;' };
    const body = buildNitIssueBody(42, [withFix], 'testowner', 'testrepo', 'abc123');
    expect(body).toContain('**Suggested fix:**');
    expect(body).toContain('const x = 1;');
  });

  it('omits suggested fix when not present', () => {
    const body = buildNitIssueBody(42, [nit], 'testowner', 'testrepo', 'abc123');
    expect(body).not.toContain('**Suggested fix:**');
  });

  it('uses nit emoji for nit findings', () => {
    const body = buildNitIssueBody(42, [nit], 'testowner', 'testrepo', 'abc123');
    expect(body).toContain('\u{1F4DD} **Use const instead of let**');
  });

  it('includes GitHub permalink for code context', () => {
    const body = buildNitIssueBody(42, [nit], 'testowner', 'testrepo', 'abc123');
    expect(body).toContain('https://github.com/testowner/testrepo/blob/abc123/src/utils.ts#L5-L20');
  });

  it('clamps permalink start line to 1 for low line numbers', () => {
    const lowLine: Finding = { ...nit, line: 2 };
    const body = buildNitIssueBody(42, [lowLine], 'testowner', 'testrepo', 'abc123');
    expect(body).toContain('#L1-L12');
  });

  it('wraps each finding in a details block', () => {
    const body = buildNitIssueBody(42, [nit], 'testowner', 'testrepo', 'abc123');
    expect(body).toContain('<details><summary>');
    expect(body).toContain('</summary>');
    expect(body).toContain('</details>');
  });

  it('includes triage instructions mentioning learning preferences', () => {
    const body = buildNitIssueBody(42, [nit], 'testowner', 'testrepo', 'abc123');
    expect(body).toContain('`/manki triage`');
    expect(body).toContain('**Check the box** for findings worth fixing');
    expect(body).toContain('**Leave unchecked** for findings to dismiss');
    expect(body).toContain('learn your preferences');
  });

  it('does not include the old heading format', () => {
    const body = buildNitIssueBody(42, [nit], 'testowner', 'testrepo', 'abc123');
    expect(body).not.toContain('## Review Nits from PR');
  });

  it('renders multiple findings each in their own details block', () => {
    const nit2: Finding = { ...nit, title: 'Rename variable', file: 'src/other.ts', line: 20 };
    const body = buildNitIssueBody(42, [nit, nit2], 'testowner', 'testrepo', 'abc123');
    const detailsCount = (body.match(/<details><summary>/g) || []).length;
    expect(detailsCount).toBe(2);
    const closingCount = (body.match(/<\/details>/g) || []).length;
    expect(closingCount).toBe(2);
  });

  it('wraps suggested fix in a code fence', () => {
    const withFix: Finding = { ...nit, suggestedFix: 'use `const` instead' };
    const body = buildNitIssueBody(42, [withFix], 'testowner', 'testrepo', 'abc123');
    expect(body).toContain('```');
    expect(body).toContain('use `const` instead');
  });
});

describe('postReview generalFindings', () => {
  const mockCreateReview = jest.fn().mockResolvedValue({ data: { id: 1 } });
  const mockOctokit = {
    rest: {
      pulls: {
        createReview: mockCreateReview,
      },
    },
  } as unknown as Parameters<typeof postReview>[0];

  beforeEach(() => {
    mockCreateReview.mockClear();
  });

  it('includes suggestedFix in general findings when finding has no file', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'suggestion',
          title: 'Add error handling',
          file: '',
          line: 0,
          description: 'Missing try/catch.',
          suggestedFix: 'try { op(); } catch (e) { handle(e); }',
          reviewers: ['Correctness'],
        },
      ],
      highlights: [],
      reviewComplete: true,
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const call = mockCreateReview.mock.calls[0][0];
    expect(call.event).toBe('APPROVE');
    expect(call.body).toContain('Fix: `try { op(); } catch (e) { handle(e); }`');
  });

  it('omits Fix line when finding has no suggestedFix', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'suggestion',
          title: 'Add error handling',
          file: '',
          line: 0,
          description: 'Missing try/catch.',
          reviewers: ['Correctness'],
        },
      ],
      highlights: [],
      reviewComplete: true,
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const call = mockCreateReview.mock.calls[0][0];
    expect(call.event).toBe('APPROVE');
    expect(call.body).not.toContain('Fix:');
  });

  it('truncates long suggestedFix to 200 chars in general findings', async () => {
    const longFix = 'x'.repeat(250);
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'suggestion',
          title: 'Long fix',
          file: '',
          line: 0,
          description: 'Desc.',
          suggestedFix: longFix,
          reviewers: [],
        },
      ],
      highlights: [],
      reviewComplete: true,
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('x'.repeat(200) + '...');
    expect(body).not.toContain('x'.repeat(201));
  });

  it('uses code block for suggestedFix containing backticks', async () => {
    const fixWithBackticks = 'use `foo` instead of `bar`';
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'suggestion',
          title: 'Backtick fix',
          file: '',
          line: 0,
          description: 'Desc.',
          suggestedFix: fixWithBackticks,
          reviewers: [],
        },
      ],
      highlights: [],
      reviewComplete: true,
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('```');
    expect(body).toContain(fixWithBackticks);
    expect(body).not.toContain('Fix: `');
  });

  it('uses longer fence when suggestedFix contains triple backticks', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'suggestion',
          title: 'Fence break',
          file: '',
          line: 0,
          description: 'Desc.',
          suggestedFix: 'some ```code``` here',
          reviewers: [],
        },
      ],
      highlights: [],
      reviewComplete: true,
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('````');
    expect(body).toContain('some ```code``` here');
  });

  it('includes description in general findings', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'suggestion',
          title: 'Some title',
          file: '',
          line: 0,
          description: 'Important description here.',
          reviewers: [],
        },
      ],
      highlights: [],
      reviewComplete: true,
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('Important description here.');
  });

  it('truncates review body when it exceeds max length', async () => {
    const longDesc = 'x'.repeat(70000);
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: longDesc,
      findings: [],
      highlights: [],
      reviewComplete: true,
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body.length).toBeLessThanOrEqual(60000 + 50); // cap + truncation message
    expect(body).toContain('*(Review body truncated)*');
  });

  it('includes file path in general findings when file is set but line is invalid', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [
        {
          severity: 'suggestion',
          title: 'Some title',
          file: 'src/utils.ts',
          line: 0,
          description: 'Desc.',
          reviewers: [],
        },
      ],
      highlights: [],
      reviewComplete: true,
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('`src/utils.ts`');
  });
});

describe('formatStatsOneLiner', () => {
  const baseStats: ReviewStats = {
    model: 'claude-sonnet-4-20250514',
    reviewTimeMs: 45000,
    diffLines: 120,
    diffAdditions: 80,
    diffDeletions: 40,
    filesReviewed: 5,
    agents: ['Security & Safety', 'Correctness'],
    findingsRaw: 10,
    findingsKept: 4,
    findingsDropped: 6,
    severity: { required: 1, suggestion: 2, nit: 1 },
    verdict: 'REQUEST_CHANGES',
    prNumber: 42,
    commitSha: 'abc123',
  };

  it('formats a one-liner with severity breakdown', () => {
    const result = formatStatsOneLiner(baseStats);
    expect(result).toBe('\u{1F4CA} 4 findings (1 required, 2 suggestion, 1 nit) \u00B7 120 lines \u00B7 45s');
  });

  it('omits zero-count severities', () => {
    const stats = { ...baseStats, severity: { required: 0, suggestion: 3, nit: 0 }, findingsKept: 3 };
    const result = formatStatsOneLiner(stats);
    expect(result).toContain('(3 suggestion)');
    expect(result).not.toContain('required');
    expect(result).not.toContain('nit');
  });

  it('shows none when all severities are zero', () => {
    const stats = { ...baseStats, severity: { required: 0, suggestion: 0, nit: 0 }, findingsKept: 0 };
    const result = formatStatsOneLiner(stats);
    expect(result).toContain('(none)');
  });

  it('rounds review time to nearest second', () => {
    const stats = { ...baseStats, reviewTimeMs: 1500 };
    const result = formatStatsOneLiner(stats);
    expect(result).toContain('2s');
  });
});

describe('formatStatsJson', () => {
  it('wraps stats in a collapsed details block with JSON', () => {
    const stats: ReviewStats = {
      model: 'claude-sonnet-4-20250514',
      reviewTimeMs: 30000,
      diffLines: 50,
      diffAdditions: 30,
      diffDeletions: 20,
      filesReviewed: 3,
      agents: ['Security'],
      findingsRaw: 5,
      findingsKept: 2,
      findingsDropped: 3,
      severity: { required: 1, suggestion: 1, nit: 0 },
      verdict: 'APPROVE',
      prNumber: 10,
      commitSha: 'def456',
    };
    const result = formatStatsJson(stats);
    expect(result).toContain('<details>');
    expect(result).toContain('<summary>Review stats</summary>');
    expect(result).toContain('```json');
    expect(result).toContain('"model": "claude-sonnet-4-20250514"');
    expect(result).toContain('"findingsKept": 2');
    expect(result).toContain('</details>');
  });
});

describe('postReview with stats', () => {
  const mockCreateReview = jest.fn().mockResolvedValue({ data: { id: 1 } });
  const mockOctokit = {
    rest: {
      pulls: {
        createReview: mockCreateReview,
      },
    },
  } as unknown as Parameters<typeof postReview>[0];

  beforeEach(() => {
    mockCreateReview.mockClear();
  });

  it('includes stats one-liner and collapsed JSON in review body', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'All good.',
      findings: [],
      highlights: [],
      reviewComplete: true,
    };
    const stats: ReviewStats = {
      model: 'claude-sonnet-4-20250514',
      reviewTimeMs: 60000,
      diffLines: 200,
      diffAdditions: 150,
      diffDeletions: 50,
      filesReviewed: 8,
      agents: ['Security', 'Correctness'],
      findingsRaw: 6,
      findingsKept: 3,
      findingsDropped: 3,
      severity: { required: 0, suggestion: 2, nit: 1 },
      verdict: 'APPROVE',
      prNumber: 99,
      commitSha: 'abc',
    };

    await postReview(mockOctokit, 'owner', 'repo', 99, 'abc', result, undefined, stats);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).toContain('\u{1F4CA} 3 findings');
    expect(body).toContain('200 lines');
    expect(body).toContain('60s');
    expect(body).toContain('<details>');
    expect(body).toContain('"model": "claude-sonnet-4-20250514"');
  });

  it('omits stats section when stats not provided', async () => {
    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'All good.',
      findings: [],
      highlights: [],
      reviewComplete: true,
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    const body = mockCreateReview.mock.calls[0][0].body as string;
    expect(body).not.toContain('\u{1F4CA}');
    expect(body).not.toContain('Review stats');
  });
});

describe('getSeverityLabel', () => {
  it('returns Required for required severity', () => {
    expect(getSeverityLabel('required')).toBe('Required');
  });

  it('returns Suggestion for suggestion severity', () => {
    expect(getSeverityLabel('suggestion')).toBe('Suggestion');
  });

  it('returns Nit for nit severity', () => {
    expect(getSeverityLabel('nit')).toBe('Nit');
  });

  it('returns Ignore for ignore severity', () => {
    expect(getSeverityLabel('ignore')).toBe('Ignore');
  });
});

describe('sanitizeMarkdown', () => {
  it('strips HTML comments', () => {
    expect(sanitizeMarkdown('before <!-- hidden --> after')).toBe('before  after');
  });

  it('strips HTML tags', () => {
    expect(sanitizeMarkdown('hello <script>alert(1)</script> world')).toBe('hello alert(1) world');
  });

  it('strips multiline HTML comments', () => {
    expect(sanitizeMarkdown('a <!-- multi\nline\ncomment --> b')).toBe('a  b');
  });

  it('preserves bold and emphasis', () => {
    expect(sanitizeMarkdown('**bold** and *emphasis*')).toBe('**bold** and *emphasis*');
  });

  it('strips markdown images, keeping alt text', () => {
    expect(sanitizeMarkdown('see ![logo](https://evil.com/track.png) here')).toBe('see logo here');
  });

  it('strips markdown links, keeping text', () => {
    expect(sanitizeMarkdown('click [here](https://evil.com) now')).toBe('click here now');
  });

  it('strips images inside links', () => {
    expect(sanitizeMarkdown('[![badge](https://img.url)](https://link.url)')).toBe('badge');
  });

  it('handles empty string', () => {
    expect(sanitizeMarkdown('')).toBe('');
  });

  it('handles string with no HTML', () => {
    const plain = 'Just a regular string with `code` and *emphasis*.';
    expect(sanitizeMarkdown(plain)).toBe(plain);
  });

  it('strips unclosed HTML comments', () => {
    expect(sanitizeMarkdown('before <!-- unclosed comment')).toBe('before ');
  });

  it('strips unclosed HTML tags', () => {
    expect(sanitizeMarkdown('before <div class="x"')).toBe('before ');
  });

  it('neutralizes @mentions with zero-width space', () => {
    expect(sanitizeMarkdown('cc @octocat for review')).toBe('cc @\u200Boctocat for review');
  });

  it('neutralizes @org/team mentions', () => {
    expect(sanitizeMarkdown('cc @myorg/reviewers')).toBe('cc @\u200Bmyorg/reviewers');
  });

  it('does not modify email addresses', () => {
    expect(sanitizeMarkdown('contact user@example.com')).toBe('contact user@example.com');
  });

  it('does not modify already-backticked mentions', () => {
    // The @ inside backticks is preceded by `, which is not [a-zA-Z0-9.], so
    // the regex will insert a ZWS. But since it's inside backticks GitHub won't
    // render it as a mention anyway. The important thing is we don't double-wrap.
    const input = 'see `@octocat` for details';
    const result = sanitizeMarkdown(input);
    expect(result).not.toContain('``');
  });

  it('strips attribute-less HTML tags like <details> and <div>', () => {
    expect(sanitizeMarkdown('<details>content</details>')).toBe('content');
    expect(sanitizeMarkdown('<div>inner</div>')).toBe('inner');
    expect(sanitizeMarkdown('before <b>bold</b> after')).toBe('before bold after');
    expect(sanitizeMarkdown('<summary>title</summary>')).toBe('title');
  });

  it('preserves TypeScript generics that are not HTML tag names', () => {
    expect(sanitizeMarkdown('Array<T>')).toBe('Array<T>');
    expect(sanitizeMarkdown('Map<MyType, string>')).toBe('Map<MyType, string>');
    expect(sanitizeMarkdown('Promise<Result>')).toBe('Promise<Result>');
  });

  it('strips svg and math tags', () => {
    expect(sanitizeMarkdown('before <svg width="100">circle</svg> after')).toBe('before circle after');
    expect(sanitizeMarkdown('inline <math>x+1</math> formula')).toBe('inline x+1 formula');
  });

  it('strips reference-style link definitions', () => {
    expect(sanitizeMarkdown('see [click][1]\n[1]: https://evil.com')).toBe('see click\n');
    expect(sanitizeMarkdown('[logo]: https://evil.com/img.png "alt"')).toBe('');
    expect(sanitizeMarkdown('text\n[ref]: http://example.com\nmore')).toBe('text\n\nmore');
  });

  it('strips self-closing HTML tags like <br/> and <hr />', () => {
    expect(sanitizeMarkdown('line1<br/>line2')).toBe('line1line2');
    expect(sanitizeMarkdown('line1<br />line2')).toBe('line1line2');
    expect(sanitizeMarkdown('above<hr/>below')).toBe('abovebelow');
    expect(sanitizeMarkdown('text<img src="x"/>more')).toBe('textmore');
  });

  it('handles nested bracket edge case in links via second pass', () => {
    expect(sanitizeMarkdown('[![inner](http://img)](http://link)')).toBe('inner');
  });

  it('strips nested HTML comments', () => {
    const result = sanitizeMarkdown('a <!-- <!-- --> --> b');
    expect(result).not.toContain('<!--');
    expect(result).not.toContain('-->');
    expect(result).toMatch(/^a\s+b$/);
    expect(sanitizeMarkdown('x <!-- <!-- a --> --> <!-- <!-- b --> --> y')).not.toContain('-->');
  });
});

describe('sanitizeFilePath', () => {
  it('strips backticks from file paths', () => {
    expect(sanitizeFilePath('src/`evil`.ts')).toBe("src/'evil'.ts");
  });

  it('strips newlines from file paths', () => {
    expect(sanitizeFilePath('src/file\nname.ts')).toBe('src/file name.ts');
  });

  it('strips both backticks and newlines', () => {
    expect(sanitizeFilePath('`path\nwith`\nboth')).toBe("'path with' both");
  });

  it('leaves clean paths unchanged', () => {
    expect(sanitizeFilePath('src/utils.ts')).toBe('src/utils.ts');
  });
});

describe('truncateBody', () => {
  it('returns short text unchanged', () => {
    expect(truncateBody('hello world')).toBe('hello world');
  });

  it('truncates at word boundary near the limit', () => {
    const text = 'word '.repeat(15000); // ~75000 chars
    const result = truncateBody(text);
    expect(result.length).toBeLessThanOrEqual(60000 + 50);
    expect(result).toContain('*(Review body truncated)*');
    expect(result).not.toMatch(/word$/); // should not end mid-word before the truncation notice
  });

  it('respects custom max length', () => {
    const text = 'a '.repeat(100);
    const result = truncateBody(text, 50);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result).toContain('*(Review body truncated)*');
  });
});

describe('dynamicFence', () => {
  it('returns triple backticks for content without backticks', () => {
    expect(dynamicFence('plain text')).toBe('```');
  });

  it('returns fence longer than content backtick runs', () => {
    expect(dynamicFence('some ```code``` here')).toBe('````');
  });

  it('handles content with single backticks', () => {
    expect(dynamicFence('use `foo` here')).toBe('```');
  });

  it('handles content with long backtick runs', () => {
    expect(dynamicFence('`````')).toBe('``````');
  });
});

describe('safeTruncate', () => {
  it('returns text unchanged when shorter than max', () => {
    expect(safeTruncate('hello', 10)).toBe('hello');
  });

  it('truncates normal text at boundary', () => {
    expect(safeTruncate('hello world', 5)).toBe('hello...');
  });

  it('avoids splitting a surrogate pair at the boundary', () => {
    // U+1F600 (grinning face) is a surrogate pair: \uD83D\uDE00
    const text = 'ab\u{1F600}cd';
    // maxLen=3 would land between the high and low surrogate; safeTruncate backs up
    const result = safeTruncate(text, 3);
    expect(result).toBe('ab...');
  });
});

describe('sanitizeMarkdown numeric entities', () => {
  it('decodes decimal numeric HTML entities', () => {
    expect(sanitizeMarkdown('&#60;b&#62;bold&#60;/b&#62;')).toBe('bold');
  });

  it('decodes hex numeric HTML entities', () => {
    expect(sanitizeMarkdown('&#x3C;b&#x3E;bold&#x3C;/b&#x3E;')).toBe('bold');
  });

  it('decodes mixed named and numeric entities', () => {
    expect(sanitizeMarkdown('&lt;div&#62;text&#x3C;/div&gt;')).toBe('text');
  });
});

describe('fetchFileContents', () => {
  function mockOctokit(files: Record<string, { content: string; size: number } | 'error'>) {
    return {
      rest: {
        repos: {
          getContent: jest.fn(async ({ path }: { path: string }) => {
            const entry = files[path];
            if (!entry || entry === 'error') {
              throw new Error(`Not found: ${path}`);
            }
            return {
              data: {
                content: Buffer.from(entry.content).toString('base64'),
                encoding: 'base64',
                size: entry.size,
              },
            };
          }),
        },
      },
    } as unknown as Parameters<typeof fetchFileContents>[0];
  }

  it('fetches file contents and returns a map', async () => {
    const octokit = mockOctokit({
      'src/a.ts': { content: 'const a = 1;', size: 12 },
      'src/b.ts': { content: 'const b = 2;', size: 12 },
    });

    const result = await fetchFileContents(octokit, 'owner', 'repo', 'abc123', ['src/a.ts', 'src/b.ts']);
    expect(result.size).toBe(2);
    expect(result.get('src/a.ts')).toBe('const a = 1;');
    expect(result.get('src/b.ts')).toBe('const b = 2;');
  });

  it('skips files exceeding maxFileSize', async () => {
    const octokit = mockOctokit({
      'big.ts': { content: 'x'.repeat(100), size: 60000 },
    });

    const result = await fetchFileContents(octokit, 'owner', 'repo', 'abc123', ['big.ts'], 50000);
    expect(result.size).toBe(0);
  });

  it('skips files that fail to fetch', async () => {
    const octokit = mockOctokit({
      'good.ts': { content: 'ok', size: 2 },
      'missing.ts': 'error',
    });

    const result = await fetchFileContents(octokit, 'owner', 'repo', 'abc123', ['good.ts', 'missing.ts']);
    expect(result.size).toBe(1);
    expect(result.get('good.ts')).toBe('ok');
  });

  it('respects maxTotalSize budget', async () => {
    const octokit = mockOctokit({
      'large.ts': { content: 'a'.repeat(80), size: 80 },
      'small.ts': { content: 'b'.repeat(30), size: 30 },
    });

    // Budget of 100 bytes: the large file (80) fits, small file (30) would exceed 110 > 100
    const result = await fetchFileContents(octokit, 'owner', 'repo', 'abc123', ['large.ts', 'small.ts'], 50000, 100);
    expect(result.size).toBe(1);
    expect(result.has('large.ts')).toBe(true);
  });

  it('skips binary files containing null bytes', async () => {
    const octokit = mockOctokit({
      'image.png': { content: 'header\0binary', size: 13 },
    });

    const result = await fetchFileContents(octokit, 'owner', 'repo', 'abc123', ['image.png']);
    expect(result.size).toBe(0);
  });

  it('returns empty map for empty file list', async () => {
    const octokit = mockOctokit({});
    const result = await fetchFileContents(octokit, 'owner', 'repo', 'abc123', []);
    expect(result.size).toBe(0);
  });
});

describe('resolveReferences', () => {
  function mockOctokit(files: Record<string, string | 'error'>) {
    return {
      rest: {
        repos: {
          getContent: jest.fn(async ({ path }: { path: string }) => {
            const content = files[path];
            if (!content || content === 'error') {
              throw new Error(`Not found: ${path}`);
            }
            return {
              data: {
                content: Buffer.from(content).toString('base64'),
                encoding: 'base64',
              },
            };
          }),
        },
      },
    } as unknown as Parameters<typeof resolveReferences>[0];
  }

  it('resolves a single @rules/ reference', async () => {
    const octokit = mockOctokit({
      '.claude/rules/commit-format.md': '## Commit Format\n\nKeep messages short.',
    });
    const content = 'Instructions:\n\n@rules/commit-format.md\n\nEnd.';
    const result = await resolveReferences(octokit, 'owner', 'repo', 'main', content, '.claude');

    expect(result).toContain('## Commit Format');
    expect(result).toContain('Keep messages short.');
    expect(result).not.toContain('@rules/commit-format.md');
    expect(result).toContain('End.');
  });

  it('resolves multiple references', async () => {
    const octokit = mockOctokit({
      '.claude/rules/a.md': 'Content A',
      '.claude/rules/b.md': 'Content B',
    });
    const content = '@rules/a.md\n@rules/b.md';
    const result = await resolveReferences(octokit, 'owner', 'repo', 'main', content, '.claude');

    expect(result).toContain('Content A');
    expect(result).toContain('Content B');
    expect(result).not.toContain('@rules/a.md');
    expect(result).not.toContain('@rules/b.md');
  });

  it('leaves reference as-is with comment when file is missing', async () => {
    const octokit = mockOctokit({});
    const content = 'Before\n@rules/missing.md\nAfter';
    const result = await resolveReferences(octokit, 'owner', 'repo', 'main', content, '.claude');

    expect(result).toContain('@rules/missing.md');
    expect(result).toContain('<!-- Could not resolve reference: rules/missing.md -->');
    expect(result).toContain('Before');
    expect(result).toContain('After');
  });

  it('respects max depth to prevent infinite recursion', async () => {
    const octokit = mockOctokit({
      '.claude/rules/loop.md': '@rules/loop.md',
    });
    const content = '@rules/loop.md';
    const result = await resolveReferences(octokit, 'owner', 'repo', 'main', content, '.claude');

    // At depth 0: resolves @rules/loop.md -> "@rules/loop.md" (the file content)
    // At depth 1: resolves that -> "@rules/loop.md" again
    // At depth 2: resolves that -> "@rules/loop.md" again
    // At depth 3: returns as-is (max depth reached)
    expect(result).toContain('@rules/loop.md');
  });

  it('skips path traversal attempts', async () => {
    const octokit = mockOctokit({});
    const content = 'Before\n@../../etc/passwd.md\nAfter';
    const result = await resolveReferences(octokit, 'owner', 'repo', 'main', content, '.claude');

    // The traversal reference should remain untouched (not fetched, no error comment)
    expect(result).toBe(content);
    expect(octokit.rest.repos.getContent).not.toHaveBeenCalled();
  });

  it('returns content unchanged when there are no references', async () => {
    const octokit = mockOctokit({});
    const content = '## Instructions\n\nJust regular markdown content.';
    const result = await resolveReferences(octokit, 'owner', 'repo', 'main', content, '.claude');

    expect(result).toBe(content);
  });
});

describe('fetchLinkedIssues', () => {
  const mockGet = jest.fn();
  const octokit = {
    rest: {
      issues: { get: mockGet },
    },
  } as unknown as Parameters<typeof fetchLinkedIssues>[0];

  beforeEach(() => {
    mockGet.mockReset();
  });

  it('parses "Closes #42" from PR body', async () => {
    mockGet.mockResolvedValue({ data: { number: 42, title: 'Fix bug', body: 'Some description' } });

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Closes #42');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ number: 42, title: 'Fix bug', body: 'Some description' });
    expect(mockGet).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', issue_number: 42 });
  });

  it('parses "fixes #10" case-insensitively', async () => {
    mockGet.mockResolvedValue({ data: { number: 10, title: 'Issue 10', body: 'Body' } });

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'fixes #10');
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(10);
  });

  it('parses "Part of #5"', async () => {
    mockGet.mockResolvedValue({ data: { number: 5, title: 'Epic', body: 'Epic body' } });

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Part of #5');
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(5);
  });

  it('parses "Resolves #7"', async () => {
    mockGet.mockResolvedValue({ data: { number: 7, title: 'Issue 7', body: 'Body' } });

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Resolves #7');
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(7);
  });

  it('handles multiple references', async () => {
    mockGet.mockImplementation(({ issue_number }: { issue_number: number }) =>
      Promise.resolve({ data: { number: issue_number, title: `Issue ${issue_number}`, body: `Body ${issue_number}` } }),
    );

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Closes #1, fixes #2, resolves #3');
    expect(result).toHaveLength(3);
    expect(result.map(r => r.number)).toEqual([1, 2, 3]);
  });

  it('deduplicates same issue referenced twice', async () => {
    mockGet.mockResolvedValue({ data: { number: 42, title: 'Bug', body: 'Body' } });

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Closes #42 and also fixes #42');
    expect(result).toHaveLength(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when no references found', async () => {
    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Just a regular PR body');
    expect(result).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('returns empty array for empty body', async () => {
    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', '');
    expect(result).toEqual([]);
  });

  it('truncates long issue bodies to 2000 chars', async () => {
    const longBody = 'x'.repeat(3000);
    mockGet.mockResolvedValue({ data: { number: 1, title: 'Issue', body: longBody } });

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Closes #1');
    expect(result[0].body.length).toBeLessThan(longBody.length);
    expect(result[0].body).toContain('... (truncated)');
  });

  it('skips issues that fail to fetch', async () => {
    mockGet.mockImplementation(({ issue_number }: { issue_number: number }) => {
      if (issue_number === 1) return Promise.resolve({ data: { number: 1, title: 'Good', body: 'Body' } });
      return Promise.reject(new Error('Not found'));
    });

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Closes #1, closes #999');
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it('caps linked issues at 5', async () => {
    mockGet.mockImplementation(({ issue_number }: { issue_number: number }) =>
      Promise.resolve({ data: { number: issue_number, title: `Issue ${issue_number}`, body: `Body` } }),
    );

    const body = Array.from({ length: 8 }, (_, i) => `closes #${i + 1}`).join(' ');
    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', body);
    expect(result).toHaveLength(5);
    expect(mockGet).toHaveBeenCalledTimes(5);
  });

  it('returns consistent results on repeated calls (no stateful regex)', async () => {
    mockGet.mockResolvedValue({ data: { number: 42, title: 'Bug', body: 'Body' } });

    const first = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Closes #42');
    const second = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Closes #42');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('sanitizes issue title and body', async () => {
    mockGet.mockResolvedValue({
      data: { number: 1, title: 'Bug <!-- hidden -->', body: 'See <script>alert(1)</script> here' },
    });

    const result = await fetchLinkedIssues(octokit, 'owner', 'repo', 'Closes #1');
    expect(result[0].title).not.toContain('<!--');
    expect(result[0].body).not.toContain('<script>');
  });
});

describe('fetchSubdirClaudeMd', () => {
  function mockOctokit(
    treeEntries: Array<{ path: string; type: string }>,
    fileContents: Record<string, string>,
  ) {
    return {
      rest: {
        git: {
          getTree: jest.fn(async () => ({
            data: { tree: treeEntries },
          })),
        },
        repos: {
          getContent: jest.fn(async ({ path }: { path: string }) => {
            const content = fileContents[path];
            if (content === undefined) throw new Error(`Not found: ${path}`);
            return {
              data: {
                content: Buffer.from(content).toString('base64'),
                encoding: 'base64',
              },
            };
          }),
        },
      },
    } as unknown as Parameters<typeof fetchSubdirClaudeMd>[0];
  }

  const baseTree = [
    { path: 'CLAUDE.md', type: 'blob' },
    { path: '.claude/CLAUDE.md', type: 'blob' },
    { path: 'src/CLAUDE.md', type: 'blob' },
    { path: 'src/auth/CLAUDE.md', type: 'blob' },
    { path: 'lib/CLAUDE.md', type: 'blob' },
  ];

  it('finds CLAUDE.md in subdirectories for changed files', async () => {
    const octokit = mockOctokit(baseTree, {
      'src/CLAUDE.md': 'Source rules',
    });

    const result = await fetchSubdirClaudeMd(octokit, 'owner', 'repo', 'abc123', ['src/index.ts']);
    expect(result).toContain('## src/CLAUDE.md');
    expect(result).toContain('Source rules');
  });

  it('walks up directory tree to find nearest CLAUDE.md', async () => {
    const octokit = mockOctokit(baseTree, {
      'src/auth/CLAUDE.md': 'Auth rules',
    });

    const result = await fetchSubdirClaudeMd(octokit, 'owner', 'repo', 'abc123', ['src/auth/handlers.ts']);
    expect(result).toContain('## src/auth/CLAUDE.md');
    expect(result).toContain('Auth rules');
  });

  it('deduplicates when two changed files share the same nearest CLAUDE.md', async () => {
    const octokit = mockOctokit(baseTree, {
      'src/CLAUDE.md': 'Source rules',
    });

    const result = await fetchSubdirClaudeMd(octokit, 'owner', 'repo', 'abc123', [
      'src/foo.ts',
      'src/bar.ts',
    ]);
    const matches = result.match(/## src\/CLAUDE\.md/g);
    expect(matches).toHaveLength(1);
  });

  it('excludes root CLAUDE.md and .claude/CLAUDE.md', async () => {
    const octokit = mockOctokit(
      [{ path: 'CLAUDE.md', type: 'blob' }, { path: '.claude/CLAUDE.md', type: 'blob' }],
      {},
    );

    const result = await fetchSubdirClaudeMd(octokit, 'owner', 'repo', 'abc123', ['README.md']);
    expect(result).toBe('');
  });

  it('returns empty string when no subdirectory CLAUDE.md files exist', async () => {
    const octokit = mockOctokit(
      [{ path: 'CLAUDE.md', type: 'blob' }],
      {},
    );

    const result = await fetchSubdirClaudeMd(octokit, 'owner', 'repo', 'abc123', ['src/index.ts']);
    expect(result).toBe('');
  });

  it('returns empty string for empty changedPaths', async () => {
    const octokit = mockOctokit(baseTree, {});

    const result = await fetchSubdirClaudeMd(octokit, 'owner', 'repo', 'abc123', []);
    expect(result).toBe('');
  });

  it('fetches multiple CLAUDE.md files for changes in different directories', async () => {
    const octokit = mockOctokit(baseTree, {
      'src/CLAUDE.md': 'Source rules',
      'lib/CLAUDE.md': 'Lib rules',
    });

    const result = await fetchSubdirClaudeMd(octokit, 'owner', 'repo', 'abc123', [
      'src/index.ts',
      'lib/utils.ts',
    ]);
    expect(result).toContain('## src/CLAUDE.md');
    expect(result).toContain('Source rules');
    expect(result).toContain('## lib/CLAUDE.md');
    expect(result).toContain('Lib rules');
  });

  it('resolves @references in subdirectory CLAUDE.md files', async () => {
    const octokit = mockOctokit(baseTree, {
      'src/CLAUDE.md': '@rules/style.md',
      'src/rules/style.md': 'Style guidelines',
    });

    const result = await fetchSubdirClaudeMd(octokit, 'owner', 'repo', 'abc123', ['src/index.ts']);
    expect(result).toContain('Style guidelines');
  });

  it('skips CLAUDE.md files that fail to fetch', async () => {
    const octokit = mockOctokit(baseTree, {
      'src/CLAUDE.md': 'Source rules',
      // lib/CLAUDE.md is missing — will throw
    });

    const result = await fetchSubdirClaudeMd(octokit, 'owner', 'repo', 'abc123', [
      'src/index.ts',
      'lib/utils.ts',
    ]);
    expect(result).toContain('## src/CLAUDE.md');
    expect(result).not.toContain('lib/CLAUDE.md');
  });

  it('ignores root-level changed files with no subdirectory CLAUDE.md', async () => {
    const octokit = mockOctokit(baseTree, {});

    const result = await fetchSubdirClaudeMd(octokit, 'owner', 'repo', 'abc123', ['package.json']);
    expect(result).toBe('');
  });
});

describe('buildDashboard', () => {
  it('renders the started phase with running review and pending judge', () => {
    const data: DashboardData = { phase: 'started', lineCount: 150, agentCount: 5 };
    const md = buildDashboard(data);
    expect(md).toContain('**Manki** — Review in progress');
    expect(md).toContain('\u2713 Parsed diff — 150 lines');
    expect(md).toContain('\u23F3 Reviewing with 5 agents...');
    expect(md).toContain('\u25CB Judge — pending');
  });

  it('renders the reviewed phase with finding count and running judge', () => {
    const data: DashboardData = { phase: 'reviewed', lineCount: 300, agentCount: 3, rawFindingCount: 12 };
    const md = buildDashboard(data);
    expect(md).toContain('**Manki** — Review in progress');
    expect(md).toContain('\u2713 Parsed diff — 300 lines');
    expect(md).toContain('\u2713 Review — 3 agents \u00B7 12 findings');
    expect(md).toContain('\u23F3 Running judge...');
  });

  it('renders the complete phase with kept/dropped counts', () => {
    const data: DashboardData = {
      phase: 'complete', lineCount: 500, agentCount: 7,
      rawFindingCount: 20, keptCount: 8, droppedCount: 12,
    };
    const md = buildDashboard(data);
    expect(md).toContain('\u2713 Parsed diff — 500 lines');
    expect(md).toContain('\u2713 Review — 7 agents \u00B7 20 findings');
    expect(md).toContain('\u2713 Judge — 8 kept \u00B7 12 dropped');
  });

  it('defaults rawFindingCount to 0 when not provided in reviewed phase', () => {
    const data: DashboardData = { phase: 'reviewed', lineCount: 100, agentCount: 3 };
    const md = buildDashboard(data);
    expect(md).toContain('0 findings');
  });

  it('uses text status lines instead of a table', () => {
    const data: DashboardData = { phase: 'started', lineCount: 50, agentCount: 2 };
    const md = buildDashboard(data);
    expect(md).not.toContain('| |');
    expect(md).not.toContain('|---|');
    expect(md).toContain('\u2713 Parsed diff');
  });
});

describe('updateProgressComment', () => {
  const mockUpdateComment = jest.fn().mockResolvedValue({});
  const mockOctokit = {
    rest: {
      issues: {
        updateComment: mockUpdateComment,
      },
    },
  } as unknown as Parameters<typeof updateProgressComment>[0];

  const baseDashboard: DashboardData = {
    phase: 'complete',
    lineCount: 200,
    agentCount: 5,
    rawFindingCount: 10,
    keptCount: 3,
    droppedCount: 7,
  };

  const baseMetadata: ReviewMetadata = {
    config: {
      reviewerModel: 'claude-sonnet-4-20250514',
      judgeModel: 'claude-sonnet-4-20250514',
      reviewLevel: 'medium',
      reviewLevelReason: 'auto, 200 lines',
      teamAgents: ['Security & Safety', 'Correctness & Logic', 'Architecture & Design'],
      memoryEnabled: true,
      memoryRepo: 'owner/review-memory',
      nitHandling: 'issues',
    },
    judgeDecisions: [
      { title: 'Null dereference', severity: 'required', reasoning: 'Valid bug', confidence: 'high', kept: true },
      { title: 'Style nitpick', severity: 'ignore', reasoning: 'Intentional pattern', confidence: 'medium', kept: false },
    ],
    recap: {
      newFindings: 3,
      previouslyFlagged: 1,
      resolved: 2,
      suppressionsApplied: 1,
    },
    timing: {
      parseMs: 500,
      reviewMs: 12000,
      judgeMs: 5000,
      totalMs: 17500,
    },
  };

  beforeEach(() => {
    mockUpdateComment.mockClear();
  });

  it('renders dashboard without metadata when metadata is not provided', async () => {
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, baseDashboard);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).toContain('**Manki** — Review failed');
    expect(body).toContain('\u2713 Parsed diff');
    expect(body).toContain('\u2713 Judge');
    expect(body).not.toContain('Review metadata');
  });

  it('renders config section in metadata', async () => {
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, baseDashboard, baseMetadata);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).toContain('**Manki** — Review complete');
    expect(body).toContain('<summary>Review metadata</summary>');
    expect(body).toContain('**Config:**');
    expect(body).toContain('reviewer=claude-sonnet-4-20250514');
    expect(body).toContain('judge=claude-sonnet-4-20250514');
    expect(body).toContain('Review level: medium (auto, 200 lines)');
    expect(body).toContain('Security & Safety, Correctness & Logic, Architecture & Design');
    expect(body).toContain('enabled (owner/review-memory)');
    expect(body).toContain('Nit handling: issues');
  });

  it('renders judge decisions with kept/dropped icons', async () => {
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, baseDashboard, baseMetadata);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).toContain('**Judge decisions:**');
    expect(body).toContain('\u2713 Kept: "Null dereference"');
    expect(body).toContain('(required, high confidence)');
    expect(body).toContain('\u2717 Dropped: "Style nitpick"');
    expect(body).toContain('(ignore, medium confidence)');
  });

  it('renders recap section', async () => {
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, baseDashboard, baseMetadata);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).toContain('**Recap:**');
    expect(body).toContain('3 new findings');
    expect(body).toContain('1 previously flagged');
    expect(body).toContain('2 resolved');
    expect(body).toContain('1 suppressions applied');
  });

  it('omits zero recap counters', async () => {
    const metadata: ReviewMetadata = {
      ...baseMetadata,
      recap: { newFindings: 5, previouslyFlagged: 0, resolved: 0, suppressionsApplied: 0 },
    };
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, baseDashboard, metadata);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).toContain('5 new findings');
    expect(body).not.toContain('previously flagged');
    expect(body).not.toContain('resolved');
    expect(body).not.toContain('suppressions applied');
  });

  it('renders timing section', async () => {
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, baseDashboard, baseMetadata);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).toContain('**Timing:**');
    expect(body).toContain('Parse: 0.5s');
    expect(body).toContain('Review agents: 12.0s');
    expect(body).toContain('Judge: 5.0s');
    expect(body).toContain('Total: 17.5s');
  });

  it('omits judge decisions section when empty', async () => {
    const metadata: ReviewMetadata = { ...baseMetadata, judgeDecisions: [] };
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, baseDashboard, metadata);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).not.toContain('**Judge decisions:**');
  });

  it('shows memory disabled when not enabled', async () => {
    const metadata: ReviewMetadata = {
      ...baseMetadata,
      config: { ...baseMetadata.config, memoryEnabled: false, memoryRepo: '' },
    };
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, baseDashboard, metadata);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).toContain('Memory: disabled');
  });

  it('forces dashboard phase to complete', async () => {
    const dashboard: DashboardData = { ...baseDashboard, phase: 'reviewed' };
    await updateProgressComment(mockOctokit, 'owner', 'repo', 123, dashboard, baseMetadata);
    const body = mockUpdateComment.mock.calls[0][0].body as string;
    expect(body).toContain('\u2713 Judge');
    expect(body).not.toContain('\u23F3 Running judge');
  });
});

describe('fetchPRDiff', () => {
  it('fetches the raw diff string', async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({ data: 'diff --git a/file.ts b/file.ts' }),
        },
      },
    } as unknown as Parameters<typeof fetchPRDiff>[0];

    const result = await fetchPRDiff(mockOctokit, 'owner', 'repo', 1);
    expect(result).toBe('diff --git a/file.ts b/file.ts');
    expect(mockOctokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 1,
      mediaType: { format: 'diff' },
    });
  });
});

describe('fetchConfigFile', () => {
  it('returns decoded file content', async () => {
    const content = 'auto_review: true';
    const mockOctokit = {
      rest: {
        repos: {
          getContent: jest.fn().mockResolvedValue({
            data: {
              content: Buffer.from(content).toString('base64'),
              encoding: 'base64',
            },
          }),
        },
      },
    } as unknown as Parameters<typeof fetchConfigFile>[0];

    const result = await fetchConfigFile(mockOctokit, 'owner', 'repo', 'main', '.manki.yml');
    expect(result).toBe(content);
  });

  it('returns null when file is not found', async () => {
    const mockOctokit = {
      rest: {
        repos: {
          getContent: jest.fn().mockRejectedValue(new Error('Not found')),
        },
      },
    } as unknown as Parameters<typeof fetchConfigFile>[0];

    const result = await fetchConfigFile(mockOctokit, 'owner', 'repo', 'main', '.manki.yml');
    expect(result).toBeNull();
  });

  it('returns null when data has no content field', async () => {
    const mockOctokit = {
      rest: {
        repos: {
          getContent: jest.fn().mockResolvedValue({
            data: { type: 'dir', entries: [] },
          }),
        },
      },
    } as unknown as Parameters<typeof fetchConfigFile>[0];

    const result = await fetchConfigFile(mockOctokit, 'owner', 'repo', 'main', '.manki.yml');
    expect(result).toBeNull();
  });
});

describe('fetchRepoContext', () => {
  it('fetches CLAUDE.md files and repo description', async () => {
    const mockOctokit = {
      rest: {
        repos: {
          getContent: jest.fn().mockImplementation(({ path }: { path: string }) => {
            if (path === 'CLAUDE.md') {
              return Promise.resolve({
                data: {
                  content: Buffer.from('Root instructions').toString('base64'),
                  encoding: 'base64',
                },
              });
            }
            throw new Error('Not found');
          }),
          get: jest.fn().mockResolvedValue({
            data: { full_name: 'owner/repo', description: 'A test repo' },
          }),
        },
      },
    } as unknown as Parameters<typeof fetchRepoContext>[0];

    const result = await fetchRepoContext(mockOctokit, 'owner', 'repo', 'main');
    expect(result).toContain('Repository: owner/repo');
    expect(result).toContain('A test repo');
    expect(result).toContain('Root instructions');
  });

  it('returns empty string when no context files exist', async () => {
    const mockOctokit = {
      rest: {
        repos: {
          getContent: jest.fn().mockRejectedValue(new Error('Not found')),
          get: jest.fn().mockRejectedValue(new Error('Not found')),
        },
      },
    } as unknown as Parameters<typeof fetchRepoContext>[0];

    const result = await fetchRepoContext(mockOctokit, 'owner', 'repo', 'main');
    expect(result).toBe('');
  });
});

describe('postProgressComment', () => {
  it('posts a progress comment and returns comment ID', async () => {
    const createCommentMock = jest.fn().mockResolvedValue({ data: { id: 42 } });
    const mockOctokit = {
      rest: {
        issues: {
          createComment: createCommentMock,
        },
      },
    } as unknown as Parameters<typeof postProgressComment>[0];

    const id = await postProgressComment(mockOctokit, 'owner', 'repo', 1);
    expect(id).toBe(42);
    const body = createCommentMock.mock.calls[0][0].body as string;
    expect(body).toContain(BOT_MARKER);
    expect(body).toContain('Review started');
  });

  it('uses dashboard data when provided', async () => {
    const createCommentMock = jest.fn().mockResolvedValue({ data: { id: 43 } });
    const mockOctokit = {
      rest: {
        issues: {
          createComment: createCommentMock,
        },
      },
    } as unknown as Parameters<typeof postProgressComment>[0];

    const dashboard: DashboardData = { phase: 'started', lineCount: 100, agentCount: 3 };
    const id = await postProgressComment(mockOctokit, 'owner', 'repo', 1, dashboard);
    expect(id).toBe(43);
    const body = createCommentMock.mock.calls[0][0].body as string;
    expect(body).toContain('100 lines');
    expect(body).toContain('3 agents');
  });
});

describe('updateProgressDashboard', () => {
  it('updates comment with dashboard content', async () => {
    const updateCommentMock = jest.fn().mockResolvedValue({});
    const mockOctokit = {
      rest: {
        issues: {
          updateComment: updateCommentMock,
        },
      },
    } as unknown as Parameters<typeof updateProgressDashboard>[0];

    const dashboard: DashboardData = { phase: 'reviewed', lineCount: 200, agentCount: 5, rawFindingCount: 8 };
    await updateProgressDashboard(mockOctokit, 'owner', 'repo', 123, dashboard);
    const body = updateCommentMock.mock.calls[0][0].body as string;
    expect(body).toContain(BOT_MARKER);
    expect(body).toContain('8 findings');
  });
});

describe('dismissPreviousReviews', () => {
  it('dismisses reviews with bot marker and CHANGES_REQUESTED state', async () => {
    const dismissMock = jest.fn().mockResolvedValue({});
    const mockOctokit = {
      rest: {
        pulls: {
          listReviews: jest.fn().mockResolvedValue({
            data: [
              { id: 1, body: `${BOT_MARKER}\nSome review`, state: 'CHANGES_REQUESTED' },
              { id: 2, body: 'Human review', state: 'CHANGES_REQUESTED' },
              { id: 3, body: `${BOT_MARKER}\nApproved`, state: 'APPROVED' },
            ],
          }),
          dismissReview: dismissMock,
        },
      },
    } as unknown as Parameters<typeof dismissPreviousReviews>[0];

    await dismissPreviousReviews(mockOctokit, 'owner', 'repo', 1);
    expect(dismissMock).toHaveBeenCalledTimes(1);
    expect(dismissMock).toHaveBeenCalledWith(expect.objectContaining({ review_id: 1 }));
  });

  it('handles dismiss failure gracefully', async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          listReviews: jest.fn().mockResolvedValue({
            data: [{ id: 1, body: `${BOT_MARKER}\nReview`, state: 'CHANGES_REQUESTED' }],
          }),
          dismissReview: jest.fn().mockRejectedValue(new Error('Forbidden')),
        },
      },
    } as unknown as Parameters<typeof dismissPreviousReviews>[0];

    // Should not throw
    await dismissPreviousReviews(mockOctokit, 'owner', 'repo', 1);
  });
});

describe('reactToIssueComment', () => {
  it('creates a reaction on an issue comment', async () => {
    const createMock = jest.fn().mockResolvedValue({});
    const mockOctokit = {
      rest: {
        reactions: {
          createForIssueComment: createMock,
        },
      },
    } as unknown as Parameters<typeof reactToIssueComment>[0];

    await reactToIssueComment(mockOctokit, 'owner', 'repo', 123, 'rocket');
    expect(createMock).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 123,
      content: 'rocket',
    });
  });

  it('silently ignores reaction failures', async () => {
    const mockOctokit = {
      rest: {
        reactions: {
          createForIssueComment: jest.fn().mockRejectedValue(new Error('Forbidden')),
        },
      },
    } as unknown as Parameters<typeof reactToIssueComment>[0];

    await reactToIssueComment(mockOctokit, 'owner', 'repo', 123, '+1');
  });
});

describe('reactToReviewComment', () => {
  it('creates a reaction on a review comment', async () => {
    const createMock = jest.fn().mockResolvedValue({});
    const mockOctokit = {
      rest: {
        reactions: {
          createForPullRequestReviewComment: createMock,
        },
      },
    } as unknown as Parameters<typeof reactToReviewComment>[0];

    await reactToReviewComment(mockOctokit, 'owner', 'repo', 456, 'heart');
    expect(createMock).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 456,
      content: 'heart',
    });
  });

  it('silently ignores reaction failures', async () => {
    const mockOctokit = {
      rest: {
        reactions: {
          createForPullRequestReviewComment: jest.fn().mockRejectedValue(new Error('Forbidden')),
        },
      },
    } as unknown as Parameters<typeof reactToReviewComment>[0];

    await reactToReviewComment(mockOctokit, 'owner', 'repo', 456, 'eyes');
  });
});

describe('createNitIssue', () => {
  it('returns null when no nit findings exist', async () => {
    const mockOctokit = {} as unknown as Parameters<typeof createNitIssue>[0];
    const findings: Finding[] = [
      { severity: 'required', title: 'Bug', file: 'a.ts', line: 1, description: 'Desc', reviewers: [] },
    ];

    const result = await createNitIssue(mockOctokit, 'owner', 'repo', 1, findings, 'sha');
    expect(result).toBeNull();
  });

  it('returns existing issue number if nit issue already exists', async () => {
    const mockOctokit = {
      rest: {
        search: {
          issuesAndPullRequests: jest.fn().mockResolvedValue({
            data: { total_count: 1, items: [{ number: 99 }] },
          }),
        },
      },
    } as unknown as Parameters<typeof createNitIssue>[0];

    const findings: Finding[] = [
      { severity: 'nit', title: 'Style', file: 'a.ts', line: 1, description: 'Desc', reviewers: [] },
    ];

    const result = await createNitIssue(mockOctokit, 'owner', 'repo', 1, findings, 'sha');
    expect(result).toBe(99);
  });

  it('creates a new nit issue with label', async () => {
    const createIssueMock = jest.fn().mockResolvedValue({ data: { number: 200 } });
    const mockOctokit = {
      rest: {
        search: {
          issuesAndPullRequests: jest.fn().mockResolvedValue({ data: { total_count: 0, items: [] } }),
        },
        issues: {
          getLabel: jest.fn().mockResolvedValue({}),
          create: createIssueMock,
        },
      },
    } as unknown as Parameters<typeof createNitIssue>[0];

    const findings: Finding[] = [
      { severity: 'nit', title: 'Style issue', file: 'a.ts', line: 5, description: 'Minor style.', reviewers: [] },
    ];

    const result = await createNitIssue(mockOctokit, 'owner', 'repo', 42, findings, 'abc123');
    expect(result).toBe(200);
    expect(createIssueMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'triage: findings from PR #42',
      labels: ['needs-human'],
    }));
  });

  it('creates the needs-human label if it does not exist', async () => {
    const createLabelMock = jest.fn().mockResolvedValue({});
    const mockOctokit = {
      rest: {
        search: {
          issuesAndPullRequests: jest.fn().mockResolvedValue({ data: { total_count: 0, items: [] } }),
        },
        issues: {
          getLabel: jest.fn().mockRejectedValue(new Error('Not found')),
          createLabel: createLabelMock,
          create: jest.fn().mockResolvedValue({ data: { number: 201 } }),
        },
      },
    } as unknown as Parameters<typeof createNitIssue>[0];

    const findings: Finding[] = [
      { severity: 'nit', title: 'Nit', file: 'a.ts', line: 1, description: 'Desc', reviewers: [] },
    ];

    await createNitIssue(mockOctokit, 'owner', 'repo', 1, findings, 'sha');
    expect(createLabelMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'needs-human' }));
  });
});

describe('postReview fallback paths', () => {
  it('retries without inline comments when line validation error occurs', async () => {
    const createReviewMock = jest.fn()
      .mockRejectedValueOnce(new Error('pull_request_review_thread.line must be part of the diff'))
      .mockResolvedValueOnce({ data: { id: 2 } });

    const mockOctokit = {
      rest: { pulls: { createReview: createReviewMock } },
    } as unknown as Parameters<typeof postReview>[0];

    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [{
        severity: 'suggestion',
        title: 'Some issue',
        file: 'src/a.ts',
        line: 10,
        description: 'Desc.',
        reviewers: ['Test'],
      }],
      highlights: [],
      reviewComplete: true,
    };

    const reviewId = await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    expect(reviewId).toBe(2);
    expect(createReviewMock).toHaveBeenCalledTimes(2);
    // Second call should have empty comments
    expect(createReviewMock.mock.calls[1][0].comments).toEqual([]);
  });

  it('falls back to COMMENT when APPROVE fails due to permission', async () => {
    const createReviewMock = jest.fn()
      .mockRejectedValueOnce(new Error('Resource not accessible by integration'))
      .mockResolvedValueOnce({ data: { id: 3 } });

    const mockOctokit = {
      rest: { pulls: { createReview: createReviewMock } },
    } as unknown as Parameters<typeof postReview>[0];

    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'All good.',
      findings: [{
        severity: 'suggestion',
        title: 'Minor thing',
        file: 'src/a.ts',
        line: 10,
        description: 'Desc.',
        reviewers: [],
      }],
      highlights: [],
      reviewComplete: true,
    };

    const reviewId = await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    expect(reviewId).toBe(3);
    expect(createReviewMock.mock.calls[1][0].event).toBe('COMMENT');
  });

  it('falls back to COMMENT when REQUEST_CHANGES fails', async () => {
    const createReviewMock = jest.fn()
      .mockRejectedValueOnce(new Error('Permission denied'))
      .mockResolvedValueOnce({ data: { id: 4 } });

    const mockOctokit = {
      rest: { pulls: { createReview: createReviewMock } },
    } as unknown as Parameters<typeof postReview>[0];

    const result: ReviewResult = {
      verdict: 'REQUEST_CHANGES',
      summary: 'Issues found.',
      findings: [{
        severity: 'required',
        title: 'Critical bug here',
        file: 'src/a.ts',
        line: 10,
        description: 'Desc.',
        reviewers: [],
      }],
      highlights: [],
      reviewComplete: true,
    };

    const reviewId = await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result);
    expect(reviewId).toBe(4);
    expect(createReviewMock.mock.calls[1][0].event).toBe('COMMENT');
  });

  it('throws when COMMENT event fails (no further fallback)', async () => {
    const createReviewMock = jest.fn().mockRejectedValue(new Error('API error'));
    const mockOctokit = {
      rest: { pulls: { createReview: createReviewMock } },
    } as unknown as Parameters<typeof postReview>[0];

    const result: ReviewResult = {
      verdict: 'COMMENT',
      summary: 'Comment.',
      findings: [{
        severity: 'suggestion',
        title: 'Some issue',
        file: 'src/a.ts',
        line: 10,
        description: 'Desc.',
        reviewers: [],
      }],
      highlights: [],
      reviewComplete: true,
    };

    await expect(postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result)).rejects.toThrow('API error');
  });

  it('moves findings to body when diff file is not found', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({ data: { id: 5 } });
    const mockOctokit = {
      rest: { pulls: { createReview: createReviewMock } },
    } as unknown as Parameters<typeof postReview>[0];

    const diff: ParsedDiff = {
      files: [{ path: 'src/other.ts', changeType: 'modified', hunks: [] }],
      totalAdditions: 5,
      totalDeletions: 0,
    };

    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [{
        severity: 'suggestion',
        title: 'Issue in missing file',
        file: 'src/missing.ts',
        line: 10,
        description: 'Desc.',
        reviewers: [],
      }],
      highlights: [],
      reviewComplete: true,
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result, diff);
    const body = createReviewMock.mock.calls[0][0].body as string;
    expect(body).toContain('Findings (not on changed lines)');
    expect(body).toContain('Issue in missing file');
    expect(createReviewMock.mock.calls[0][0].comments).toEqual([]);
  });

  it('includes recap summary in review body when provided', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({ data: { id: 6 } });
    const mockOctokit = {
      rest: { pulls: { createReview: createReviewMock } },
    } as unknown as Parameters<typeof postReview>[0];

    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'All good.',
      findings: [],
      highlights: [],
      reviewComplete: true,
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result, undefined, undefined, 'Findings: 2 new, 1 resolved');
    const body = createReviewMock.mock.calls[0][0].body as string;
    expect(body).toContain('Findings: 2 new, 1 resolved');
  });

  it('moves finding to body when file has empty hunks and line cannot be resolved', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({ data: { id: 7 } });
    const mockOctokit = {
      rest: { pulls: { createReview: createReviewMock } },
    } as unknown as Parameters<typeof postReview>[0];

    const diff: ParsedDiff = {
      files: [{
        path: 'src/a.ts',
        changeType: 'modified',
        hunks: [],
      }],
      totalAdditions: 1,
      totalDeletions: 0,
    };

    const result: ReviewResult = {
      verdict: 'APPROVE',
      summary: 'Summary',
      findings: [{
        severity: 'suggestion',
        title: 'Issue in empty hunk file',
        file: 'src/a.ts',
        line: 10,
        description: 'Desc.',
        reviewers: [],
      }],
      highlights: [],
      reviewComplete: true,
    };

    await postReview(mockOctokit, 'owner', 'repo', 1, 'sha', result, diff);
    const body = createReviewMock.mock.calls[0][0].body as string;
    expect(body).toContain('Findings (not on changed lines)');
    expect(body).toContain('Issue in empty hunk file');
  });
});

describe('getSeverityEmoji', () => {
  it('returns correct emoji for each severity', () => {
    expect(getSeverityEmoji('required')).toBe('\u{1F6AB}');
    expect(getSeverityEmoji('suggestion')).toBe('\u{1F4A1}');
    expect(getSeverityEmoji('nit')).toBe('\u{1F4DD}');
    expect(getSeverityEmoji('ignore')).toBe('\u26AA');
  });
});
