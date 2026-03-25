import {
  buildJudgeSystemPrompt,
  buildJudgeUserMessage,
  extractCodeContext,
  parseJudgeResponse,
  filterMemoryForFindings,
  runJudgeAgent,
  JudgeInput,
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
  max_diff_lines: 10000,
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
    const prompt = buildJudgeSystemPrompt(makeConfig());
    expect(prompt).toContain('required');
    expect(prompt).toContain('suggestion');
    expect(prompt).toContain('nit');
    expect(prompt).toContain('ignore');
  });

  it('contains evaluation criteria', () => {
    const prompt = buildJudgeSystemPrompt(makeConfig());
    expect(prompt).toContain('Accuracy');
    expect(prompt).toContain('Actionability');
    expect(prompt).toContain('Severity');
  });

  it('includes project instructions when present', () => {
    const prompt = buildJudgeSystemPrompt(makeConfig({ instructions: 'Use strict TypeScript.' }));
    expect(prompt).toContain('Use strict TypeScript.');
    expect(prompt).toContain('Project Instructions');
  });

  it('omits project instructions section when empty', () => {
    const prompt = buildJudgeSystemPrompt(makeConfig({ instructions: '' }));
    expect(prompt).not.toContain('Project Instructions');
  });

  it('defines the judge role', () => {
    const prompt = buildJudgeSystemPrompt(makeConfig());
    expect(prompt).toContain('code review judge');
  });

  it('includes severity examples for each level', () => {
    const prompt = buildJudgeSystemPrompt(makeConfig());
    // required examples
    expect(prompt).toContain('SQL injection');
    expect(prompt).toContain('Null/undefined dereference');
    expect(prompt).toContain('Off-by-one');
    // suggestion examples
    expect(prompt).toContain('logging "failed"');
    expect(prompt).toContain('const');
    expect(prompt).toContain('reusable helper');
    // nit examples
    expect(prompt).toContain('connectionCount');
    expect(prompt).toContain('import ordering');
    expect(prompt).toContain('JSDoc');
    // ignore examples (judge only)
    expect(prompt).toContain('TODO with a tracking issue');
    expect(prompt).toContain('workaround documented');
    expect(prompt).toContain('ternary vs if/else');
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
  it('parses valid JSON array with all fields', () => {
    const json = JSON.stringify([
      { title: 'Bug found', severity: 'required', reasoning: 'This is a real bug.', confidence: 'high' },
    ]);

    const result = parseJudgeResponse(json);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Bug found');
    expect(result[0].severity).toBe('required');
    expect(result[0].reasoning).toBe('This is a real bug.');
    expect(result[0].confidence).toBe('high');
  });

  it('parses JSON wrapped in markdown code fences', () => {
    const json = '```json\n[{"title":"Bug","severity":"required","reasoning":"Real bug.","confidence":"high"}]\n```';

    const result = parseJudgeResponse(json);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Bug');
  });

  it('defaults missing confidence to medium', () => {
    const json = JSON.stringify([
      { title: 'Test', severity: 'suggestion', reasoning: 'Okay.' },
    ]);

    const result = parseJudgeResponse(json);
    expect(result[0].confidence).toBe('medium');
  });

  it('defaults invalid severity to suggestion', () => {
    const json = JSON.stringify([
      { title: 'Test', severity: 'critical', reasoning: 'Something.', confidence: 'high' },
    ]);

    const result = parseJudgeResponse(json);
    expect(result[0].severity).toBe('suggestion');
  });

  it('returns empty array for empty response', () => {
    const result = parseJudgeResponse('');
    expect(result).toEqual([]);
  });

  it('returns empty array for malformed JSON', () => {
    const result = parseJudgeResponse('not json {broken');
    expect(result).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    const result = parseJudgeResponse('{"not": "an array"}');
    expect(result).toEqual([]);
  });

  it('handles missing title and reasoning gracefully', () => {
    const json = JSON.stringify([{ severity: 'nit' }]);

    const result = parseJudgeResponse(json);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Untitled');
    expect(result[0].reasoning).toBe('');
  });

  it('parses multiple findings', () => {
    const json = JSON.stringify([
      { title: 'A', severity: 'required', reasoning: 'Bug.', confidence: 'high' },
      { title: 'B', severity: 'ignore', reasoning: 'False positive.', confidence: 'low' },
    ]);

    const result = parseJudgeResponse(json);
    expect(result).toHaveLength(2);
    expect(result[0].severity).toBe('required');
    expect(result[1].severity).toBe('ignore');
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

  it('returns empty array for empty findings', async () => {
    const input: JudgeInput = {
      findings: [],
      diff: makeDiff(),
      rawDiff: '',
      repoContext: '',
    };

    const result = await runJudgeAgent(mockClient, makeConfig(), input);
    expect(result).toEqual([]);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('calls client and returns updated findings', async () => {
    const judgedResponse = JSON.stringify([
      { title: 'Unused variable', severity: 'ignore', reasoning: 'False positive.', confidence: 'high' },
    ]);
    mockSendMessage.mockResolvedValue({ content: judgedResponse });

    const input: JudgeInput = {
      findings: [makeFinding()],
      diff: makeDiff(),
      rawDiff: '',
      repoContext: '',
    };

    const result = await runJudgeAgent(mockClient, makeConfig(), input);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('ignore');
    expect(result[0].judgeNotes).toBe('False positive.');
    expect(result[0].judgeConfidence).toBe('high');
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('passes effort option to sendMessage', async () => {
    const judgedResponse = JSON.stringify([
      { title: 'Unused variable', severity: 'suggestion', reasoning: 'Real issue.', confidence: 'high' },
    ]);
    mockSendMessage.mockResolvedValue({ content: judgedResponse });

    const input: JudgeInput = {
      findings: [makeFinding()],
      diff: makeDiff(),
      rawDiff: '',
      repoContext: '',
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
    };

    const result = await runJudgeAgent(mockClient, makeConfig(), input);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('required');
    expect(result[0].judgeNotes).toBeUndefined();
  });

  it('matches judge findings by fuzzy title when order differs', async () => {
    const judgedResponse = JSON.stringify([
      { title: 'Different title', severity: 'nit', reasoning: 'Minor.', confidence: 'low' },
      { title: 'Unused variable cleanup', severity: 'ignore', reasoning: 'Not real.', confidence: 'high' },
    ]);
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
    };

    const result = await runJudgeAgent(mockClient, makeConfig(), input);
    expect(result).toHaveLength(2);
    // "Unused variable" should fuzzy-match "Unused variable cleanup" => severity 'ignore'
    expect(result[0].severity).toBe('ignore');
    expect(result[0].judgeNotes).toBe('Not real.');
    // "Something completely different" matches "Different title" by position => severity 'nit'
    expect(result[1].severity).toBe('nit');
    expect(result[1].judgeNotes).toBe('Minor.');
  });

  it('includes memory context when memory is provided', async () => {
    const judgedResponse = JSON.stringify([
      { title: 'Unused variable', severity: 'ignore', reasoning: 'Suppressed.', confidence: 'high' },
    ]);
    mockSendMessage.mockResolvedValue({ content: judgedResponse });

    const input: JudgeInput = {
      findings: [makeFinding()],
      diff: makeDiff(),
      rawDiff: '',
      memory: makeMemory(),
      repoContext: '',
    };

    await runJudgeAgent(mockClient, makeConfig(), input);

    const [, userMessage] = mockSendMessage.mock.calls[0];
    expect(userMessage).toContain('Relevant Suppressions');
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
