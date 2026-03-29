import {
  buildJudgeSystemPrompt,
  buildJudgeUserMessage,
  extractCodeContext,
  parseJudgeResponse,
  filterMemoryForFindings,
  mapJudgedToFindings,
  deduplicateFindings,
  runJudgeAgent,
  JudgeInput,
  JudgedFinding,
} from './judge';
import { ClaudeClient } from './claude';
import { RepoMemory, Learning, Suppression } from './memory';
import { LinkedIssue } from './github';
import { Finding, ReviewConfig, ParsedDiff, DiffFile, DiffHunk } from './types';

const makeConfig = (overrides: Partial<ReviewConfig> = {}): ReviewConfig => ({
  model: 'claude-opus-4-6',
  auto_review: true,
  auto_approve: true,
  review_language: 'en',
  include_paths: ['**/*'],
  exclude_paths: [],
  max_diff_lines: 50000,
  reviewers: [],
  review_level: 'auto',
  review_thresholds: { small: 200, medium: 1000 },
  instructions: '',
  memory: { enabled: false, repo: '' },
  ...overrides,
});

const makeFinding = (overrides: Partial<Finding> = {}): Finding => ({
  severity: 'suggestion',
  title: 'Unused variable',
  file: 'src/index.ts',
  line: 10,
  description: 'Variable x is unused.',
  reviewers: ['TestReviewer'],
  ...overrides,
});

const makeHunk = (overrides: Partial<DiffHunk> = {}): DiffHunk => ({
  oldStart: 1,
  oldLines: 20,
  newStart: 1,
  newLines: 20,
  content: Array.from({ length: 20 }, (_, i) => `+line ${i + 1}`).join('\n'),
  ...overrides,
});

const makeDiffFile = (overrides: Partial<DiffFile> = {}): DiffFile => ({
  path: 'src/index.ts',
  changeType: 'modified',
  hunks: [makeHunk()],
  ...overrides,
});

const makeDiff = (files: DiffFile[] = [makeDiffFile()]): ParsedDiff => ({
  files,
  totalAdditions: 20,
  totalDeletions: 0,
});

const makeLearning = (overrides: Partial<Learning> = {}): Learning => ({
  id: 'l1',
  content: 'Always check for null before accessing properties',
  scope: 'repo',
  source: 'repo#1',
  created_at: '2025-01-01',
  ...overrides,
});

const makeSuppression = (overrides: Partial<Suppression> = {}): Suppression => ({
  id: 'sup-1',
  pattern: 'unused variable',
  reason: 'Intentional for future use',
  created_by: 'dev',
  created_at: '2025-01-01',
  pr_ref: 'owner/repo#1',
  ...overrides,
});

const makeMemory = (overrides: Partial<RepoMemory> = {}): RepoMemory => ({
  learnings: [makeLearning()],
  suppressions: [makeSuppression()],
  patterns: [],
  ...overrides,
});

describe('buildJudgeSystemPrompt', () => {
  it('contains severity definitions', () => {
    const prompt = buildJudgeSystemPrompt(makeConfig(), 5);
    expect(prompt).toContain('required');
    expect(prompt).toContain('suggestion');
    expect(prompt).toContain('nit');
    expect(prompt).toContain('ignore');
  });

  it('contains evaluation criteria', () => {
    const prompt = buildJudgeSystemPrompt(makeConfig(), 5);
    expect(prompt).toContain('Accuracy');
    expect(prompt).toContain('Actionability');
    expect(prompt).toContain('Severity');
  });

  it('includes project instructions when present', () => {
    const prompt = buildJudgeSystemPrompt(makeConfig({ instructions: 'Use strict TypeScript.' }), 5);
    expect(prompt).toContain('Use strict TypeScript.');
    expect(prompt).toContain('Project Instructions');
  });

  it('omits project instructions section when empty', () => {
    const prompt = buildJudgeSystemPrompt(makeConfig({ instructions: '' }), 5);
    expect(prompt).not.toContain('Project Instructions');
  });

  it('defines the judge role', () => {
    const prompt = buildJudgeSystemPrompt(makeConfig(), 5);
    expect(prompt).toContain('code review judge');
  });

  it('includes duplicate detection instructions', () => {
    const prompt = buildJudgeSystemPrompt(makeConfig(), 5);
    expect(prompt).toContain('Duplicate Detection');
    expect(prompt).toContain('ONE entry for the merged finding');
  });

  it('does not include scope validation (handled by reviewers)', () => {
    const prompt = buildJudgeSystemPrompt(makeConfig(), 5);
    expect(prompt).not.toContain('Scope Validation');
  });

  it('includes severity examples for each level', () => {
    const prompt = buildJudgeSystemPrompt(makeConfig(), 5);
    // required examples
    expect(prompt).toContain('SQL injection');
    expect(prompt).toContain('Null/undefined dereference');
    expect(prompt).toContain('Missing error handling');
    // suggestion examples
    expect(prompt).toContain('Error message lacks context');
    expect(prompt).toContain('const');
    expect(prompt).toContain('extracting a helper');
    // nit examples
    expect(prompt).toContain('Variable name could be more descriptive');
    expect(prompt).toContain('import ordering');
    expect(prompt).toContain('JSDoc');
    // ignore examples (judge only)
    expect(prompt).toContain('TODO with a tracking issue');
    expect(prompt).toContain('workaround documented');
    expect(prompt).toContain('Style preference that does not affect correctness');
  });

  it('contains Reviewer Consensus section with dynamic thresholds', () => {
    const prompt = buildJudgeSystemPrompt(makeConfig(), 5);
    expect(prompt).toContain('## Reviewer Consensus');
    expect(prompt).toContain('This review used 5 specialist agents');
    expect(prompt).toContain('3+ of 5');
    expect(prompt).toContain('2+ of 5');
    expect(prompt).toContain('1 of 5');
  });

  it('adapts majority threshold to team size', () => {
    const prompt3 = buildJudgeSystemPrompt(makeConfig(), 3);
    expect(prompt3).toContain('2+ of 3');
    expect(prompt3).toContain('This review used 3 specialist agents');

    const prompt7 = buildJudgeSystemPrompt(makeConfig(), 7);
    expect(prompt7).toContain('4+ of 7');
    expect(prompt7).toContain('This review used 7 specialist agents');
  });

  it('contains Acceptance Criteria section', () => {
    const prompt = buildJudgeSystemPrompt(makeConfig(), 5);
    expect(prompt).toContain('## Acceptance Criteria');
    expect(prompt).toContain('unmet acceptance criterion');
    expect(prompt).toContain('partially met criterion');
  });

  it('contains Impact and Likelihood severity framework', () => {
    const prompt = buildJudgeSystemPrompt(makeConfig(), 5);
    expect(prompt).toContain('## Severity Assessment');
    expect(prompt).toContain('**Impact**');
    expect(prompt).toContain('**Likelihood**');
    expect(prompt).toContain('**Severity mapping:**');
    expect(prompt).toContain('Critical/High impact + Certain/Probable likelihood');
  });
});

describe('buildJudgeUserMessage', () => {
  it('includes finding details', () => {
    const findings = [makeFinding({ title: 'Null pointer', file: 'src/app.ts', line: 42 })];
    const msg = buildJudgeUserMessage(findings, new Map(), '');

    expect(msg).toContain('Finding 1: Null pointer');
    expect(msg).toContain('src/app.ts:42');
    expect(msg).toContain('TestReviewer');
  });

  it('includes code context when available', () => {
    const findings = [makeFinding()];
    const ctx = new Map([['src/index.ts:10:Unused variable', '>>> 10: +line 10']]);
    const msg = buildJudgeUserMessage(findings, ctx, '');

    expect(msg).toContain('>>> 10: +line 10');
    expect(msg).toContain('Code context');
  });

  it('includes memory context when provided', () => {
    const findings = [makeFinding()];
    const msg = buildJudgeUserMessage(findings, new Map(), 'Some memory context');

    expect(msg).toContain('Project Memory');
    expect(msg).toContain('Some memory context');
  });

  it('omits memory section when empty', () => {
    const findings = [makeFinding()];
    const msg = buildJudgeUserMessage(findings, new Map(), '');

    expect(msg).not.toContain('Project Memory');
  });

  it('includes suggested fix when present', () => {
    const findings = [makeFinding({ suggestedFix: 'Remove the variable.' })];
    const msg = buildJudgeUserMessage(findings, new Map(), '');

    expect(msg).toContain('Remove the variable.');
    expect(msg).toContain('Suggested fix');
  });

  it('handles multiple findings', () => {
    const findings = [
      makeFinding({ title: 'Finding A' }),
      makeFinding({ title: 'Finding B' }),
    ];
    const msg = buildJudgeUserMessage(findings, new Map(), '');

    expect(msg).toContain('Finding 1: Finding A');
    expect(msg).toContain('Finding 2: Finding B');
    expect(msg).toContain('2 total');
  });

  it('includes PR context when provided', () => {
    const findings = [makeFinding()];
    const prContext = { title: 'Add auth middleware', body: '', baseBranch: 'main' };
    const msg = buildJudgeUserMessage(findings, new Map(), '', prContext);

    expect(msg).toContain('## Pull Request');
    expect(msg).toContain('**Title**: Add auth middleware');
    expect(msg).toContain('**Base branch**: main');
  });

  it('omits PR context when undefined', () => {
    const findings = [makeFinding()];
    const msg = buildJudgeUserMessage(findings, new Map(), '');

    expect(msg).not.toContain('## Pull Request\n');
  });

  it('includes changed files with summaries when provided', () => {
    const findings = [makeFinding()];
    const changedFiles: DiffFile[] = [
      makeDiffFile({ path: 'src/foo.ts' }),
      makeDiffFile({ path: 'src/bar.ts', hunks: [makeHunk({ newLines: 10, oldLines: 5 })] }),
      makeDiffFile({ path: '.manki.yml', hunks: [] }),
    ];
    const msg = buildJudgeUserMessage(findings, new Map(), '', undefined, undefined, changedFiles);

    expect(msg).toContain('## Changed Files in This PR');
    expect(msg).toContain('### src/foo.ts (+20/-20)');
    expect(msg).toContain('### src/bar.ts (+10/-5)');
    expect(msg).toContain('### .manki.yml (+0/-0)');
    expect(msg).toContain('+line 1');
  });

  it('omits changed files section when empty', () => {
    const findings = [makeFinding()];
    const msg = buildJudgeUserMessage(findings, new Map(), '', undefined, undefined, []);

    expect(msg).not.toContain('## Changed Files in This PR');
  });

  it('omits changed files section when undefined', () => {
    const findings = [makeFinding()];
    const msg = buildJudgeUserMessage(findings, new Map(), '');

    expect(msg).not.toContain('## Changed Files in This PR');
  });
});

describe('extractCodeContext', () => {
  it('extracts context around the finding line', () => {
    const finding = makeFinding({ file: 'src/index.ts', line: 10 });
    const diff = makeDiff();

    const ctx = extractCodeContext(finding, diff);
    expect(ctx).toContain('>>> 10:');
    expect(ctx).toContain('+line 10');
  });

  it('returns empty string when file not in diff', () => {
    const finding = makeFinding({ file: 'src/other.ts', line: 5 });
    const diff = makeDiff();

    expect(extractCodeContext(finding, diff)).toBe('');
  });

  it('returns empty string when line not in any hunk', () => {
    const finding = makeFinding({ file: 'src/index.ts', line: 100 });
    const diff = makeDiff();

    expect(extractCodeContext(finding, diff)).toBe('');
  });

  it('returns empty string for finding with no file', () => {
    const finding = makeFinding({ file: '', line: 10 });
    const diff = makeDiff();

    expect(extractCodeContext(finding, diff)).toBe('');
  });

  it('returns empty string for finding with no line', () => {
    const finding = makeFinding({ file: 'src/index.ts', line: 0 });
    const diff = makeDiff();

    expect(extractCodeContext(finding, diff)).toBe('');
  });

  it('clips context at hunk boundaries', () => {
    const finding = makeFinding({ file: 'src/index.ts', line: 2 });
    const diff = makeDiff();

    const ctx = extractCodeContext(finding, diff);
    expect(ctx).toContain('+line 1');
    expect(ctx).toContain('>>> 2:');
  });
});

describe('parseJudgeResponse', () => {
  it('parses object format with summary and findings', () => {
    const json = JSON.stringify({
      summary: 'Clean PR with one minor issue.',
      findings: [
        { title: 'Bug found', severity: 'required', reasoning: 'This is a real bug.', confidence: 'high' },
      ],
    });

    const result = parseJudgeResponse(json);
    expect(result.summary).toBe('Clean PR with one minor issue.');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe('Bug found');
    expect(result.findings[0].severity).toBe('required');
    expect(result.findings[0].reasoning).toBe('This is a real bug.');
    expect(result.findings[0].confidence).toBe('high');
  });

  it('falls back to default summary when plain array is returned', () => {
    const json = JSON.stringify([
      { title: 'Bug found', severity: 'required', reasoning: 'This is a real bug.', confidence: 'high' },
    ]);

    const result = parseJudgeResponse(json);
    expect(result.summary).toBe('Review complete.');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe('Bug found');
  });

  it('falls back to default summary when summary is missing from object', () => {
    const json = JSON.stringify({
      findings: [
        { title: 'Test', severity: 'suggestion', reasoning: 'Okay.', confidence: 'medium' },
      ],
    });

    const result = parseJudgeResponse(json);
    expect(result.summary).toBe('Review complete.');
    expect(result.findings).toHaveLength(1);
  });

  it('parses JSON wrapped in markdown code fences', () => {
    const json = '```json\n[{"title":"Bug","severity":"required","reasoning":"Real bug.","confidence":"high"}]\n```';

    const result = parseJudgeResponse(json);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe('Bug');
  });

  it('defaults missing confidence to medium', () => {
    const json = JSON.stringify([
      { title: 'Test', severity: 'suggestion', reasoning: 'Okay.' },
    ]);

    const result = parseJudgeResponse(json);
    expect(result.findings[0].confidence).toBe('medium');
  });

  it('defaults invalid severity to suggestion', () => {
    const json = JSON.stringify([
      { title: 'Test', severity: 'critical', reasoning: 'Something.', confidence: 'high' },
    ]);

    const result = parseJudgeResponse(json);
    expect(result.findings[0].severity).toBe('suggestion');
  });

  it('returns empty findings for empty response', () => {
    const result = parseJudgeResponse('');
    expect(result.findings).toEqual([]);
    expect(result.summary).toBe('Review complete.');
  });

  it('returns empty findings for malformed JSON', () => {
    const result = parseJudgeResponse('not json {broken');
    expect(result.findings).toEqual([]);
  });

  it('returns empty findings for unrecognized object', () => {
    const result = parseJudgeResponse('{"not": "an array"}');
    expect(result.findings).toEqual([]);
    expect(result.summary).toBe('Review complete.');
  });

  it('handles missing title and reasoning gracefully', () => {
    const json = JSON.stringify([{ severity: 'nit' }]);

    const result = parseJudgeResponse(json);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe('Untitled');
    expect(result.findings[0].reasoning).toBe('');
  });

  it('parses multiple findings', () => {
    const json = JSON.stringify([
      { title: 'A', severity: 'required', reasoning: 'Bug.', confidence: 'high' },
      { title: 'B', severity: 'ignore', reasoning: 'False positive.', confidence: 'low' },
    ]);

    const result = parseJudgeResponse(json);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].severity).toBe('required');
    expect(result.findings[1].severity).toBe('ignore');
  });
});

describe('filterMemoryForFindings', () => {
  it('returns matching learnings by keyword', () => {
    const findings = [makeFinding({ title: 'Null check missing', description: 'Missing null check on property access.' })];
    const memory = makeMemory({
      learnings: [makeLearning({ content: 'Always check for null before accessing properties' })],
      suppressions: [],
    });

    const result = filterMemoryForFindings(findings, memory);
    expect(result).toContain('null');
    expect(result).toContain('Relevant Learnings');
  });

  it('returns matching suppressions', () => {
    const findings = [makeFinding({ title: 'Unused variable detected' })];
    const memory = makeMemory({
      learnings: [],
      suppressions: [makeSuppression({ pattern: 'unused variable' })],
    });

    const result = filterMemoryForFindings(findings, memory);
    expect(result).toContain('unused variable');
    expect(result).toContain('Relevant Suppressions');
  });

  it('returns empty string when nothing matches', () => {
    const findings = [makeFinding({ title: 'Security vulnerability', description: 'SQL injection.' })];
    const memory = makeMemory({
      learnings: [makeLearning({ content: 'Use consistent naming conventions' })],
      suppressions: [makeSuppression({ pattern: 'unused variable' })],
    });

    const result = filterMemoryForFindings(findings, memory);
    expect(result).toBe('');
  });

  it('returns empty string for empty memory', () => {
    const findings = [makeFinding()];
    const memory = makeMemory({ learnings: [], suppressions: [] });

    expect(filterMemoryForFindings(findings, memory)).toBe('');
  });
});

describe('runJudgeAgent', () => {
  const mockSendMessage = jest.fn();
  const mockClient = {
    sendMessage: mockSendMessage,
  } as unknown as ClaudeClient;

  beforeEach(() => {
    mockSendMessage.mockReset();
  });

  it('returns empty findings with default summary for empty findings', async () => {
    const input: JudgeInput = {
      findings: [],
      diff: makeDiff(),
      rawDiff: '',
      repoContext: '',
      agentCount: 5,
    };

    const result = await runJudgeAgent(mockClient, makeConfig(), input);
    expect(result.findings).toEqual([]);
    expect(result.summary).toBe('Review complete.');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('calls client and returns updated findings with summary', async () => {
    const judgedResponse = JSON.stringify({
      summary: 'One false positive found.',
      findings: [
        { title: 'Unused variable', severity: 'ignore', reasoning: 'False positive.', confidence: 'high' },
      ],
    });
    mockSendMessage.mockResolvedValue({ content: judgedResponse });

    const input: JudgeInput = {
      findings: [makeFinding()],
      diff: makeDiff(),
      rawDiff: '',
      repoContext: '',
      agentCount: 5,
    };

    const result = await runJudgeAgent(mockClient, makeConfig(), input);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('ignore');
    expect(result.findings[0].judgeNotes).toBe('False positive.');
    expect(result.findings[0].judgeConfidence).toBe('high');
    expect(result.summary).toBe('One false positive found.');
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('passes effort option to sendMessage', async () => {
    const judgedResponse = JSON.stringify({
      summary: 'Real issue found.',
      findings: [
        { title: 'Unused variable', severity: 'suggestion', reasoning: 'Real issue.', confidence: 'high' },
      ],
    });
    mockSendMessage.mockResolvedValue({ content: judgedResponse });

    const input: JudgeInput = {
      findings: [makeFinding()],
      diff: makeDiff(),
      rawDiff: '',
      repoContext: '',
      agentCount: 5,
    };

    await runJudgeAgent(mockClient, makeConfig(), input);

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { effort: 'high' },
    );
  });

  it('returns originals when judge response is empty', async () => {
    mockSendMessage.mockResolvedValue({ content: '' });

    const finding = makeFinding({ severity: 'required' });
    const input: JudgeInput = {
      findings: [finding],
      diff: makeDiff(),
      rawDiff: '',
      repoContext: '',
      agentCount: 5,
    };

    const result = await runJudgeAgent(mockClient, makeConfig(), input);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('required');
    expect(result.findings[0].judgeNotes).toBeUndefined();
  });

  it('matches judge findings by fuzzy title when order differs', async () => {
    const judgedResponse = JSON.stringify({
      summary: 'Mixed findings.',
      findings: [
        { title: 'Different title', severity: 'nit', reasoning: 'Minor.', confidence: 'low' },
        { title: 'Unused variable cleanup', severity: 'ignore', reasoning: 'Not real.', confidence: 'high' },
      ],
    });
    mockSendMessage.mockResolvedValue({ content: judgedResponse });

    const input: JudgeInput = {
      findings: [
        makeFinding({ title: 'Unused variable' }),
        makeFinding({ title: 'Something completely different', file: 'b.ts', line: 5 }),
      ],
      diff: makeDiff([
        makeDiffFile({ path: 'src/index.ts' }),
        makeDiffFile({ path: 'b.ts' }),
      ]),
      rawDiff: '',
      repoContext: '',
      agentCount: 5,
    };

    const result = await runJudgeAgent(mockClient, makeConfig(), input);
    expect(result.findings).toHaveLength(2);
    // "Unused variable" should fuzzy-match "Unused variable cleanup" => severity 'ignore'
    expect(result.findings[0].severity).toBe('ignore');
    expect(result.findings[0].judgeNotes).toBe('Not real.');
    // "Something completely different" matches "Different title" by position => severity 'nit'
    expect(result.findings[1].severity).toBe('nit');
    expect(result.findings[1].judgeNotes).toBe('Minor.');
  });

  it('includes memory context when memory is provided', async () => {
    const judgedResponse = JSON.stringify({
      summary: 'Suppressed finding.',
      findings: [
        { title: 'Unused variable', severity: 'ignore', reasoning: 'Suppressed.', confidence: 'high' },
      ],
    });
    mockSendMessage.mockResolvedValue({ content: judgedResponse });

    const input: JudgeInput = {
      findings: [makeFinding()],
      diff: makeDiff(),
      rawDiff: '',
      memory: makeMemory(),
      repoContext: '',
      agentCount: 5,
    };

    await runJudgeAgent(mockClient, makeConfig(), input);

    const [, userMessage] = mockSendMessage.mock.calls[0];
    expect(userMessage).toContain('Relevant Suppressions');
  });
});

describe('mapJudgedToFindings', () => {
  it('handles 1:1 mapping when judge returns same count', () => {
    const originals = [
      makeFinding({ title: 'Bug A', severity: 'suggestion', reviewers: ['R1'] }),
      makeFinding({ title: 'Bug B', severity: 'suggestion', reviewers: ['R2'], file: 'b.ts' }),
    ];
    const judged: JudgedFinding[] = [
      { title: 'Bug A', severity: 'required', reasoning: 'Real bug.', confidence: 'high' },
      { title: 'Bug B', severity: 'nit', reasoning: 'Minor.', confidence: 'low' },
    ];

    const result = mapJudgedToFindings(originals, judged);
    expect(result).toHaveLength(2);
    expect(result[0].severity).toBe('required');
    expect(result[1].severity).toBe('nit');
  });

  it('handles fewer judge results by merging duplicates', () => {
    const originals = [
      makeFinding({ title: 'Null check missing', severity: 'suggestion', reviewers: ['SecurityReviewer'] }),
      makeFinding({ title: 'Missing null check', severity: 'required', reviewers: ['BugReviewer'] }),
      makeFinding({ title: 'Unused import', severity: 'nit', reviewers: ['StyleReviewer'] }),
    ];
    const judged: JudgedFinding[] = [
      { title: 'Null check missing', severity: 'required', reasoning: 'Merged findings 1 and 2 — same issue.', confidence: 'high' },
      { title: 'Unused import', severity: 'nit', reasoning: 'Minor style issue.', confidence: 'medium' },
    ];

    const result = mapJudgedToFindings(originals, judged);
    expect(result).toHaveLength(2);

    // First result should have merged reviewers from both null-check findings
    expect(result[0].severity).toBe('required');
    expect(result[0].reviewers).toContain('SecurityReviewer');
    expect(result[0].reviewers).toContain('BugReviewer');
    expect(result[0].judgeNotes).toContain('Merged findings 1 and 2');

    // Second result maps normally
    expect(result[1].severity).toBe('nit');
    expect(result[1].reviewers).toEqual(['StyleReviewer']);
  });

  it('deduplicates reviewers when merging', () => {
    const originals = [
      makeFinding({ title: 'Error handling', reviewers: ['R1', 'R2'] }),
      makeFinding({ title: 'Error handling missing', reviewers: ['R2', 'R3'] }),
    ];
    const judged: JudgedFinding[] = [
      { title: 'Error handling', severity: 'suggestion', reasoning: 'Merged.', confidence: 'medium' },
    ];

    const result = mapJudgedToFindings(originals, judged);
    expect(result).toHaveLength(1);
    expect(result[0].reviewers).toHaveLength(3);
    expect(result[0].reviewers).toContain('R1');
    expect(result[0].reviewers).toContain('R2');
    expect(result[0].reviewers).toContain('R3');
  });

  it('uses the longest description when merging', () => {
    const originals = [
      makeFinding({ title: 'Null check', description: 'Short.' }),
      makeFinding({ title: 'Null check missing', description: 'This is a much more detailed description of the null check issue.' }),
    ];
    const judged: JudgedFinding[] = [
      { title: 'Null check', severity: 'required', reasoning: 'Merged.', confidence: 'high' },
    ];

    const result = mapJudgedToFindings(originals, judged);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('This is a much more detailed description of the null check issue.');
  });
});

describe('buildJudgeUserMessage with linked issues', () => {
  it('includes linked issues section when provided', () => {
    const findings = [makeFinding()];
    const issues: LinkedIssue[] = [
      { number: 42, title: 'Implement caching', body: 'Add Redis caching for API responses.' },
    ];
    const msg = buildJudgeUserMessage(findings, new Map(), '', undefined, issues);

    expect(msg).toContain('## Linked Issues');
    expect(msg).toContain('### Issue #42: Implement caching');
    expect(msg).toContain('Add Redis caching for API responses.');
  });

  it('omits linked issues section when empty', () => {
    const findings = [makeFinding()];
    const msg = buildJudgeUserMessage(findings, new Map(), '', undefined, []);

    expect(msg).not.toContain('## Linked Issues');
  });

  it('omits linked issues section when undefined', () => {
    const findings = [makeFinding()];
    const msg = buildJudgeUserMessage(findings, new Map(), '');

    expect(msg).not.toContain('## Linked Issues');
  });
});

describe('deduplicateFindings', () => {
  it('removes findings with identical title and file', () => {
    const findings = [
      makeFinding({ title: 'Null check', file: 'src/a.ts', line: 10, reviewers: ['R1'] }),
      makeFinding({ title: 'Null check', file: 'src/a.ts', line: 20, reviewers: ['R2'] }),
    ];

    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(1);
    expect(result[0].reviewers).toEqual(['R1']);
  });

  it('keeps findings with same title but different files', () => {
    const findings = [
      makeFinding({ title: 'Null check', file: 'src/a.ts' }),
      makeFinding({ title: 'Null check', file: 'src/b.ts' }),
    ];

    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(2);
  });

  it('keeps findings with same file but different titles', () => {
    const findings = [
      makeFinding({ title: 'Null check', file: 'src/a.ts' }),
      makeFinding({ title: 'Unused import', file: 'src/a.ts' }),
    ];

    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(2);
  });

  it('preserves the first occurrence and drops subsequent duplicates', () => {
    const findings = [
      makeFinding({ title: 'Bug', file: 'x.ts', severity: 'required', description: 'First' }),
      makeFinding({ title: 'Bug', file: 'x.ts', severity: 'nit', description: 'Second' }),
      makeFinding({ title: 'Bug', file: 'x.ts', severity: 'suggestion', description: 'Third' }),
    ];

    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('required');
    expect(result[0].description).toBe('First');
  });

  it('returns empty array for empty input', () => {
    expect(deduplicateFindings([])).toEqual([]);
  });

  it('returns all findings when there are no duplicates', () => {
    const findings = [
      makeFinding({ title: 'A', file: '1.ts' }),
      makeFinding({ title: 'B', file: '2.ts' }),
      makeFinding({ title: 'C', file: '3.ts' }),
    ];

    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(3);
  });
});
